//! The project registry command handlers.
//!
//! The `#[tauri::command]` handlers over the project registry, registered in
//! `lib.rs` as `commands::project::*` and invoked from the webview. They sit ABOVE
//! the persistence layer: each mutation goes through the
//! [`ProjectStore`](crate::project::ProjectStore) (persist) and emits `nc:project`
//! so the webview re-renders the switcher + Projects view. Activating a project
//! up-calls [`crate::orchestration`] to reconcile its worktrees, which is why
//! these handlers live in this command layer rather than in the `store/project`
//! persistence leaf.

use std::path::Path;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::project::{Project, ProjectStore};
use crate::store::TaskStore;

/// The Tauri event carrying registry changes to the webview. Payload:
/// `{ type, project, projects }`. The webview re-renders the switcher + Projects
/// view; on `activated` it re-seeds the board from `list_tasks`.
pub const PROJECT_EVENT: &str = "nc:project";

// --- Git helpers ------------------------------------------------------------

/// Whether `path` is (inside) a git repo: a `.git` exists at the path.
fn path_is_git_repo(path: &str) -> bool {
    Path::new(path).join(".git").exists()
}

/// Best-effort current branch via `git rev-parse --abbrev-ref HEAD`.
fn current_branch(path: &str) -> Option<String> {
    let out = crate::platform::std_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if branch.is_empty() {
        None
    } else {
        Some(branch)
    }
}

/// Emit `nc:project` with the registry snapshot and the (optional) subject project.
fn emit_project_event(
    app: &AppHandle,
    store: &ProjectStore,
    kind: &str,
    project: Option<&Project>,
) {
    let _ = app.emit(
        PROJECT_EVENT,
        serde_json::json!({
            "type": kind,
            "project": project,
            "projects": store.list(),
        }),
    );
}

/// Point the task store (and the Insight runs store) at the active project's dirs
/// (or empty scratch dirs under the config dir when no project is active),
/// reloading the board and the analysis history.
fn retarget_tasks(app: &AppHandle, store: &ProjectStore) {
    let tasks = app.state::<TaskStore>();
    let dir = store
        .active_tasks_dir()
        .unwrap_or_else(|| store.config_dir.join("no-active-project/tasks"));
    tasks.retarget(dir);

    // Insight analysis runs are project-scoped too.
    let insights = app.state::<crate::store::insight::InsightStore>();
    let insights_dir = store
        .active_insights_dir()
        .unwrap_or_else(|| store.config_dir.join("no-active-project/insights"));
    insights.retarget(insights_dir);

    // Harness scans are project-scoped too.
    let harness = app.state::<crate::store::harness::HarnessStore>();
    let harness_dir = store
        .active_harness_dir()
        .unwrap_or_else(|| store.config_dir.join("no-active-project/harness"));
    harness.retarget(harness_dir);

    // Readiness Scorecard runs are project-scoped too.
    let scorecards = app.state::<crate::store::scorecard::ScorecardStore>();
    let scorecards_dir = store
        .active_scorecards_dir()
        .unwrap_or_else(|| store.config_dir.join("no-active-project/scorecards"));
    scorecards.retarget(scorecards_dir);
}

// --- Commands ---------------------------------------------------------------

/// All known projects (registry order).
#[tauri::command]
pub fn list_projects(store: State<'_, ProjectStore>) -> Result<Vec<Project>, String> {
    Ok(store.list())
}

/// The active project, if any.
#[tauri::command]
pub fn active_project(store: State<'_, ProjectStore>) -> Result<Option<Project>, String> {
    Ok(store.active())
}

/// Register a new project at `path`, validate it is a git repo, scaffold its
/// `.nightcore/`, persist, and activate it. Emits `nc:project { type: "created" }`.
#[tauri::command]
pub fn create_project(
    app: AppHandle,
    store: State<'_, ProjectStore>,
    path: String,
    name: String,
) -> Result<Project, String> {
    if !path_is_git_repo(&path) {
        return Err(format!("{path} is not a git repository"));
    }
    // Scaffold the per-project `.nightcore/` so the task store has a home.
    let nightcore = Path::new(&path).join(".nightcore");
    std::fs::create_dir_all(nightcore.join("tasks"))
        .map_err(|e| format!("failed to scaffold .nightcore: {e}"))?;

    let project = Project::new(name, path.clone(), current_branch(&path));
    store.add(project.clone())?;
    let activated = store.set_active(&project.id)?;
    retarget_tasks(&app, &store);
    emit_project_event(&app, &store, "created", Some(&activated));
    Ok(activated)
}

/// Remove a project from the registry. Leaves the repo + its `.nightcore/` on
/// disk (deleting files is destructive). Emits `nc:project { type: "deleted" }`.
#[tauri::command]
pub fn delete_project(
    app: AppHandle,
    store: State<'_, ProjectStore>,
    id: String,
) -> Result<(), String> {
    let was_active = store.active().map(|p| p.id) == Some(id.clone());
    if !store.remove(&id)? {
        return Err(format!("no project with id {id}"));
    }
    // Data-integrity #4: drop the deleted project's settings override so it can't
    // orphan in settings.json (best-effort — a persist failure here must not undo
    // the registry removal, so it's logged, not propagated).
    if let Err(e) = app
        .state::<crate::settings::SettingsStore>()
        .drop_project_override(&id)
    {
        tracing::warn!(target: "nightcore::project", project_id = %id, error = %e, "failed to drop project settings override on delete");
    }
    // Custom Background: remove the deleted project's on-disk background bytes too
    // (its settings ref went with the override above). Best-effort — a leftover image
    // is harmless and must not undo the delete.
    if let Err(e) = crate::store::board_background::remove(&app, &id) {
        tracing::warn!(target: "nightcore::project", project_id = %id, error = %e, "failed to remove project board background on delete");
    }
    // Deleting the active project clears the board.
    if was_active {
        retarget_tasks(&app, &store);
    }
    emit_project_event(&app, &store, "deleted", None);
    Ok(())
}

/// Activate `id`: retarget the task store at its tasks dir, reload, and bump
/// `lastActiveAt`. Emits `nc:project { type: "activated" }`.
#[tauri::command]
pub fn set_active_project(
    app: AppHandle,
    store: State<'_, ProjectStore>,
    id: String,
) -> Result<Project, String> {
    let project = store.set_active(&id)?;
    retarget_tasks(&app, &store);
    // Reconcile the newly-active project's worktrees: prune any whose task no
    // longer exists (the task store has just been retargeted to this project).
    crate::orchestration::coordinator::reconcile_worktrees(&app);
    emit_project_event(&app, &store, "activated", Some(&project));
    Ok(project)
}

/// Rename a project in the registry. Updates only `name` (the repo on disk and
/// its tasks dir are unaffected) and persists. Emits `nc:project { type:
/// "renamed" }` with the updated project so the switcher + Projects view (and
/// the active label, when it's the active project) re-render.
#[tauri::command]
pub fn rename_project(
    app: AppHandle,
    store: State<'_, ProjectStore>,
    id: String,
    name: String,
) -> Result<Project, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("project name cannot be empty".to_string());
    }
    let project = store.rename(&id, name)?;
    emit_project_event(&app, &store, "renamed", Some(&project));
    Ok(project)
}

/// Whether `path` is a git repository.
#[tauri::command]
pub fn is_git_repo(path: String) -> Result<bool, String> {
    Ok(path_is_git_repo(&path))
}

/// Initialize a git repository at `path` (`git init`).
#[tauri::command]
pub fn git_init(path: String) -> Result<(), String> {
    let out = crate::platform::std_command("git")
        .arg("init")
        .current_dir(&path)
        .output()
        .map_err(|e| format!("failed to run git init (is `git` on PATH?): {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn is_git_repo_detects_dot_git() {
        let tmp = TempDir::new().expect("create temp dir");
        let path = tmp.path().to_string_lossy().to_string();
        assert!(!path_is_git_repo(&path), "fresh dir is not a repo");
        std::fs::create_dir(tmp.path().join(".git")).expect("mkdir .git");
        assert!(path_is_git_repo(&path), ".git present → repo");
    }
}
