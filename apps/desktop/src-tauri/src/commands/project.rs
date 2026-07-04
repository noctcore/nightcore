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

use std::path::{Path, PathBuf};

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

/// Validate a renderer-supplied filesystem path before any command uses it as a
/// git / scaffold target. These `#[tauri::command]` handlers take a raw `path:
/// String` over IPC; a compromised or XSS'd webview (or any code that reaches
/// `invoke`) could otherwise create `.git`/`.nightcore` at an attacker-chosen
/// location or probe arbitrary path existence. We require an ABSOLUTE, CANONICAL
/// (symlinks + `..` resolved), EXISTING directory. In normal use the path comes
/// from the native folder picker, which always yields exactly that — so this
/// rejects only paths a legitimate picker never produces.
fn validate_existing_dir(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }
    if !Path::new(trimmed).is_absolute() {
        return Err(format!("path must be absolute: {trimmed}"));
    }
    // canonicalize resolves `..`/symlinks and REQUIRES the path to exist, so a
    // non-existent attacker target and any `..`-traversal are both rejected here.
    let canonical = std::fs::canonicalize(trimmed)
        .map_err(|e| format!("path does not resolve to an existing location: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("path is not a directory: {}", canonical.display()));
    }
    Ok(canonical)
}

/// System-owned directory trees under which we refuse to scaffold `.git` /
/// `.nightcore` — a renderer-reachable write there is never a legitimate project
/// registration. Deliberately excludes `/var` (& `/private/var`): macOS temp dirs
/// canonicalize under `/private/var/folders`, and dogfooding/scratch repos live
/// there, so denying it would break first-party flows. Applied to the WRITE
/// commands (`create_project` / `git_init`) only; `is_git_repo` is read-only.
fn reject_sensitive_root(dir: &Path) -> Result<(), String> {
    if dir.parent().is_none() {
        return Err("refusing to operate on the filesystem root".to_string());
    }
    const DENY_PREFIXES: &[&str] = &["/System", "/usr", "/bin", "/sbin", "/etc", "/private/etc"];
    for deny in DENY_PREFIXES {
        if dir.starts_with(deny) {
            return Err(format!(
                "refusing to create project files under a system directory: {}",
                dir.display()
            ));
        }
    }
    Ok(())
}

/// Best-effort current branch via `git rev-parse --abbrev-ref HEAD`.
fn current_branch(path: &str) -> Option<String> {
    let out = crate::platform::git_command(Path::new(path))
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
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

    // Every run-based scan store is project-scoped too. Retarget each from the ONE
    // `scan_kinds!` registry so a new scan kind needs no parallel edit here.
    macro_rules! retarget_scan {
        ($Run:ty, $slug:literal) => {{
            let scan_store = app.state::<crate::store::run_store::RunStore<$Run>>();
            let scan_dir = store
                .active_scan_dir($slug)
                .unwrap_or_else(|| store.config_dir.join("no-active-project").join($slug));
            scan_store.retarget(scan_dir);
        }};
    }
    crate::store::run_store::scan_kinds!(retarget_scan);
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
    // Validate the renderer-supplied path before any filesystem side effect:
    // absolute, canonical, existing directory, and not under a system root.
    let dir = validate_existing_dir(&path)?;
    reject_sensitive_root(&dir)?;
    let path = dir.to_string_lossy().to_string();
    if !path_is_git_repo(&path) {
        return Err(format!("{path} is not a git repository"));
    }
    // Scaffold the per-project `.nightcore/` so the task store has a home.
    let nightcore = dir.join(".nightcore");
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

/// Whether `path` is a git repository. Read-only: an invalid / non-existent /
/// relative path is simply "not a repo" (`Ok(false)`), so this can't be used as
/// a filesystem existence oracle for arbitrary strings.
#[tauri::command]
pub fn is_git_repo(path: String) -> Result<bool, String> {
    match validate_existing_dir(&path) {
        Ok(dir) => Ok(dir.join(".git").exists()),
        Err(_) => Ok(false),
    }
}

/// Initialize a git repository at `path` (`git init`).
#[tauri::command]
pub fn git_init(path: String) -> Result<(), String> {
    // Validate before spawning: absolute, canonical, existing directory, and not
    // under a system root (this WRITES a `.git` into the target).
    let dir = validate_existing_dir(&path)?;
    reject_sensitive_root(&dir)?;
    let out = crate::platform::git_command(&dir)
        .arg("init")
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

    #[test]
    fn validate_existing_dir_rejects_untrusted_shapes_and_accepts_a_real_dir() {
        // Empty / whitespace-only.
        assert!(validate_existing_dir("").is_err());
        assert!(validate_existing_dir("   ").is_err());
        // Relative (the picker never yields these).
        assert!(validate_existing_dir("relative/path").is_err());
        assert!(validate_existing_dir("../escape").is_err());
        // Absolute but non-existent → canonicalize fails.
        assert!(validate_existing_dir("/no/such/nightcore/path/xyz").is_err());
        // A real existing directory (first-party picker shape) is accepted and
        // returned canonicalized.
        let tmp = TempDir::new().expect("temp dir");
        let got = validate_existing_dir(&tmp.path().to_string_lossy()).expect("valid dir");
        assert!(got.is_absolute() && got.is_dir());
    }

    #[test]
    fn validate_existing_dir_rejects_a_file() {
        let tmp = TempDir::new().expect("temp dir");
        let file = tmp.path().join("f.txt");
        std::fs::write(&file, "x").expect("write");
        assert!(validate_existing_dir(&file.to_string_lossy()).is_err());
    }

    #[test]
    fn reject_sensitive_root_blocks_system_dirs_but_allows_a_project_dir() {
        // System-owned trees a renderer must never scaffold into.
        assert!(reject_sensitive_root(Path::new("/")).is_err());
        assert!(reject_sensitive_root(Path::new("/etc")).is_err());
        assert!(reject_sensitive_root(Path::new("/etc/nightcore-evil")).is_err());
        assert!(reject_sensitive_root(Path::new("/usr/local/evil")).is_err());
        assert!(reject_sensitive_root(Path::new("/System/Library/x")).is_err());
        // A normal user project dir (and a temp dir under /private/var/folders,
        // where dogfooding/scratch repos live) is allowed.
        let tmp = TempDir::new().expect("temp dir");
        let canonical = std::fs::canonicalize(tmp.path()).expect("canonical");
        assert!(
            reject_sensitive_root(&canonical).is_ok(),
            "temp/project dir must be allowed: {}",
            canonical.display()
        );
    }

    #[test]
    fn is_git_repo_returns_false_for_untrusted_paths_not_an_error_oracle() {
        // Relative / non-existent inputs are simply "not a repo", never an error
        // that leaks whether a path exists.
        assert_eq!(is_git_repo(String::new()), Ok(false));
        assert_eq!(is_git_repo("relative".to_string()), Ok(false));
        assert_eq!(is_git_repo("/no/such/xyz/repo".to_string()), Ok(false));
        // A real repo dir still reports true.
        let tmp = TempDir::new().expect("temp dir");
        std::fs::create_dir(tmp.path().join(".git")).expect("mkdir .git");
        assert_eq!(
            is_git_repo(tmp.path().to_string_lossy().to_string()),
            Ok(true)
        );
    }
}
