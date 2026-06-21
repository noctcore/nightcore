//! The project registry — multi-repo support (Phase 2).
//!
//! Nightcore points at a git repo at a time. The registry of known projects, plus
//! which one is active, lives in Tauri's **app config dir** (not in any single
//! repo): `projects.json` (the `Vec<Project>` registry) and `active.json`
//! (`{ activeProjectId }`). Per-project **tasks** stay where M1 put them, under
//! `<project.path>/.nightcore/tasks/` — activating a project retargets the
//! [`TaskStore`](crate::store::TaskStore) there.
//!
//! Held in managed Tauri state; commands take it as `State<'_, ProjectStore>`.

use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::store::TaskStore;

/// The Tauri event carrying registry changes to the webview. Payload:
/// `{ type, project, projects }`. The webview re-renders the switcher + Projects
/// view; on `activated` it re-seeds the board from `list_tasks`.
pub const PROJECT_EVENT: &str = "nc:project";

/// A known project: a git repo Nightcore can drive. Field names mirror the
/// Phase 2 contract and serialize camelCase for the TS bridge and on-disk JSON.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// Absolute repo path.
    pub path: String,
    /// Current git branch, best-effort (`None` if it can't be resolved).
    pub branch: Option<String>,
    /// ISO8601 creation time.
    pub created_at: String,
    /// ISO8601 of the last activation, or `None` if never activated.
    pub last_active_at: Option<String>,
}

impl Project {
    fn new(name: String, path: String, branch: Option<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            path,
            branch,
            created_at: now_iso8601(),
            last_active_at: None,
        }
    }
}

/// The persisted `active.json` shape: which project is currently active.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveState {
    active_project_id: Option<String>,
}

/// The in-memory registry plus the config dir it persists to.
pub struct ProjectStore {
    projects: Mutex<Vec<Project>>,
    active_id: Mutex<Option<String>>,
    /// App config dir holding `projects.json` / `active.json`.
    config_dir: PathBuf,
}

impl ProjectStore {
    /// Load the registry from `<config_dir>/projects.json` and the active id from
    /// `active.json`, creating the dir if missing. Unparsable files start empty.
    pub fn load_from(config_dir: PathBuf) -> Self {
        if let Err(e) = std::fs::create_dir_all(&config_dir) {
            eprintln!("project store: failed to create {}: {e}", config_dir.display());
        }
        let projects = read_json(&config_dir.join("projects.json")).unwrap_or_default();
        let active: ActiveState = read_json(&config_dir.join("active.json")).unwrap_or_default();
        Self {
            projects: Mutex::new(projects),
            active_id: Mutex::new(active.active_project_id),
            config_dir,
        }
    }

    /// Snapshot of all known projects (registry order).
    pub fn list(&self) -> Vec<Project> {
        self.projects.lock().expect("project store poisoned").clone()
    }

    /// The active project, if one is set and still in the registry.
    pub fn active(&self) -> Option<Project> {
        let id = self.active_id.lock().expect("project store poisoned").clone()?;
        self.projects
            .lock()
            .expect("project store poisoned")
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    /// The tasks dir for the currently-active project, or `None` with no active
    /// project. The [`TaskStore`] is retargeted here on activation.
    pub fn active_tasks_dir(&self) -> Option<PathBuf> {
        self.active().map(|p| tasks_dir_for(&p.path))
    }

    fn add(&self, project: Project) -> Result<(), String> {
        self.projects
            .lock()
            .expect("project store poisoned")
            .push(project);
        self.persist_registry()
    }

    fn remove(&self, id: &str) -> Result<bool, String> {
        let removed = {
            let mut guard = self.projects.lock().expect("project store poisoned");
            let before = guard.len();
            guard.retain(|p| p.id != id);
            guard.len() != before
        };
        if removed {
            // Clear the active pointer if it referenced the removed project.
            let mut active = self.active_id.lock().expect("project store poisoned");
            if active.as_deref() == Some(id) {
                *active = None;
                self.persist_active(&active)?;
            }
            self.persist_registry()?;
        }
        Ok(removed)
    }

    /// Mark `id` active, bump its `lastActiveAt`, and persist both files. Returns
    /// the updated project. Errors if the id is unknown.
    fn set_active(&self, id: &str) -> Result<Project, String> {
        let project = {
            let mut guard = self.projects.lock().expect("project store poisoned");
            let project = guard
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or_else(|| format!("no project with id {id}"))?;
            project.last_active_at = Some(now_iso8601());
            project.clone()
        };
        {
            let mut active = self.active_id.lock().expect("project store poisoned");
            *active = Some(id.to_string());
            self.persist_active(&active)?;
        }
        self.persist_registry()?;
        Ok(project)
    }

    fn persist_registry(&self) -> Result<(), String> {
        let projects = self.projects.lock().expect("project store poisoned");
        write_json(&self.config_dir.join("projects.json"), &*projects)
    }

    fn persist_active(&self, active_id: &Option<String>) -> Result<(), String> {
        let state = ActiveState {
            active_project_id: active_id.clone(),
        };
        write_json(&self.config_dir.join("active.json"), &state)
    }
}

/// The tasks dir for a project path: `<path>/.nightcore/tasks`.
fn tasks_dir_for(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".nightcore/tasks")
}

/// Read + deserialize a JSON file, returning `None` on any error (missing,
/// unreadable, or unparsable) so a corrupt file never aborts startup.
fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&raw) {
        Ok(value) => Some(value),
        Err(e) => {
            eprintln!("project store: skipping {}: {e}", path.display());
            None
        }
    }
}

/// Pretty-print a value to a JSON file (write-through persistence).
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("failed to write {}: {e}", path.display()))
}

/// Current time as an ISO8601 / RFC3339 UTC string, without pulling in `chrono`:
/// epoch seconds formatted by hand. Good enough for a "created at" timestamp.
fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_iso8601(secs)
}

/// Format epoch seconds as `YYYY-MM-DDTHH:MM:SSZ` (UTC). A small civil-time
/// conversion (Howard Hinnant's algorithm) so we avoid a date dependency.
fn format_iso8601(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86_400) as i64;
    let secs_of_day = epoch_secs % 86_400;
    let (hour, min, sec) = (
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    );

    // days since 1970-01-01 → civil (y, m, d). See
    // http://howardhinnant.github.io/date_algorithms.html#civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}Z")
}

// --- Git helpers ------------------------------------------------------------

/// Whether `path` is (inside) a git repo: a `.git` exists at the path.
fn path_is_git_repo(path: &str) -> bool {
    Path::new(path).join(".git").exists()
}

/// Best-effort current branch via `git rev-parse --abbrev-ref HEAD`.
fn current_branch(path: &str) -> Option<String> {
    let out = StdCommand::new("git")
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
fn emit_project_event(app: &AppHandle, store: &ProjectStore, kind: &str, project: Option<&Project>) {
    let _ = app.emit(
        PROJECT_EVENT,
        serde_json::json!({
            "type": kind,
            "project": project,
            "projects": store.list(),
        }),
    );
}

/// Point the task store at the active project's tasks dir (or an empty scratch
/// dir under the config dir when no project is active), reloading the board.
fn retarget_tasks(app: &AppHandle, store: &ProjectStore) {
    let tasks = app.state::<TaskStore>();
    let dir = store
        .active_tasks_dir()
        .unwrap_or_else(|| store.config_dir.join("no-active-project/tasks"));
    tasks.retarget(dir);
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
    crate::m2::coordinator::reconcile_worktrees(&app);
    emit_project_event(&app, &store, "activated", Some(&project));
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
    let out = StdCommand::new("git")
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

    fn temp_store() -> (ProjectStore, TempDir) {
        let tmp = TempDir::new().expect("create temp dir");
        let store = ProjectStore::load_from(tmp.path().join("config"));
        (store, tmp)
    }

    #[test]
    fn registry_crud_round_trips_through_disk() {
        let (store, tmp) = temp_store();
        assert!(store.list().is_empty());

        let project = Project::new("nightcore".into(), "/repo/nightcore".into(), Some("main".into()));
        let id = project.id.clone();
        store.add(project).expect("add");
        store.set_active(&id).expect("activate");

        // A second store loading the same config dir reconstructs registry + active.
        let reloaded = ProjectStore::load_from(tmp.path().join("config"));
        assert_eq!(reloaded.list().len(), 1);
        assert_eq!(reloaded.active().expect("active").id, id);
        assert!(
            reloaded.active().unwrap().last_active_at.is_some(),
            "set_active persists lastActiveAt"
        );

        // Removing it drops it from the registry and clears the active pointer.
        assert!(reloaded.remove(&id).expect("remove"));
        let reloaded2 = ProjectStore::load_from(tmp.path().join("config"));
        assert!(reloaded2.list().is_empty());
        assert!(reloaded2.active().is_none());
    }

    #[test]
    fn project_serializes_camel_case() {
        let project = Project::new("p".into(), "/p".into(), None);
        let value = serde_json::to_value(&project).unwrap();
        let obj = value.as_object().unwrap();
        for key in ["createdAt", "lastActiveAt"] {
            assert!(obj.contains_key(key), "missing camelCase key {key}");
        }
    }

    #[test]
    fn active_tasks_dir_follows_the_active_project() {
        let (store, _tmp) = temp_store();
        assert!(store.active_tasks_dir().is_none(), "no project, no tasks dir");

        let project = Project::new("p".into(), "/repo/p".into(), None);
        let id = project.id.clone();
        store.add(project).expect("add");
        store.set_active(&id).expect("activate");

        assert_eq!(
            store.active_tasks_dir().unwrap(),
            PathBuf::from("/repo/p/.nightcore/tasks")
        );
    }

    #[test]
    fn iso8601_formats_a_known_epoch() {
        // 2021-01-01T00:00:00Z = 1609459200.
        assert_eq!(format_iso8601(1_609_459_200), "2021-01-01T00:00:00Z");
        // The unix epoch itself.
        assert_eq!(format_iso8601(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn is_git_repo_detects_dot_git() {
        let tmp = TempDir::new().expect("create temp dir");
        let path = tmp.path().to_string_lossy().to_string();
        assert!(!path_is_git_repo(&path), "fresh dir is not a repo");
        std::fs::create_dir(tmp.path().join(".git")).expect("mkdir .git");
        assert!(path_is_git_repo(&path), ".git present → repo");
    }
}
