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

use crate::merge::TaskLease;
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

    // The USER terminal registry's scrollback persist dir is project-scoped too
    // (its live in-memory sessions are global and survive the switch — only the
    // persist target moves). Best-effort: a missing registry (shouldn't happen)
    // just skips the retarget.
    if let Some(terminals) = app.try_state::<crate::terminal::TerminalRegistry>() {
        let terminals_dir = store
            .active()
            .map(|p| std::path::Path::new(&p.path).join(".nightcore/terminals"))
            .unwrap_or_else(|| store.config_dir.join("no-active-project/terminals"));
        terminals.retarget(terminals_dir);
    }
}

// --- Registry single-flight -------------------------------------------------

/// The registry-mutation single-flight set. The registry mutators (activate /
/// create / delete) each run "mutate registry → retarget 6 stores → reconcile
/// worktrees" as a multi-step check-and-act; while they ran synchronously the
/// main thread serialized them implicitly. Moving them to the blocking pool (so
/// a project switch can't jank the WKWebView) removes that, so this lease
/// restores single-flight: whichever action leases second refuses instead of
/// interleaving (the `CommitLease` discipline — try-acquire, never wait).
fn registry_mutation_in_flight() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static IN_FLIGHT: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    IN_FLIGHT.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Acquire the registry lease (one shared key: the registry is app-global), or
/// refuse naming the blocked action (`what` completes "… while another project
/// action is in progress").
fn acquire_registry_lease(what: &str) -> Result<TaskLease, String> {
    TaskLease::acquire(registry_mutation_in_flight(), "project-registry").ok_or_else(|| {
        format!("cannot {what} while another project action is in progress — try again")
    })
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
    // Registry mutators are single-flight (see `registry_mutation_in_flight`):
    // creating a project activates it, and that retarget must not interleave
    // with a concurrent switch/delete running on the blocking pool.
    let _lease = acquire_registry_lease("create a project")?;
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
    std::fs::create_dir_all(nightcore.join("images"))
        .map_err(|e| format!("failed to scaffold .nightcore/images: {e}"))?;

    // The project's recorded branch is the main checkout's current branch — the
    // STRICT worktree resolver (no `main` fallback; a detached HEAD reads as
    // `None`, not the literal `"HEAD"`).
    let project = Project::new(
        name,
        path.clone(),
        crate::worktree::current_branch(Path::new(&path)),
    );
    store.add(project.clone())?;
    let activated = store.set_active(&project.id)?;
    retarget_tasks(&app, &store);
    emit_project_event(&app, &store, "created", Some(&activated));
    Ok(activated)
}

/// Remove a project from the registry. Leaves the repo + its `.nightcore/` on
/// disk (deleting files is destructive). Emits `nc:project { type: "deleted" }`.
#[tauri::command]
pub async fn delete_project(app: AppHandle, id: String) -> Result<(), String> {
    // Persist + settings write + background-image removal are all filesystem
    // work; run the body on the blocking pool so the WKWebView stays responsive.
    tauri::async_runtime::spawn_blocking(move || delete_project_blocking(&app, &id))
        .await
        .map_err(|e| format!("delete project failed to run: {e}"))?
}

/// The blocking body of `delete_project`, run off the UI thread. Managed state is
/// re-acquired from the owned `AppHandle` (a `State<'_, _>` guard can't cross the
/// thread boundary); `try_state` so an unmanaged store fails gracefully.
fn delete_project_blocking(app: &AppHandle, id: &str) -> Result<(), String> {
    // Single-flight with the other registry mutators (activate / create): a
    // delete that retargets the board must not interleave with a switch.
    let _lease = acquire_registry_lease("delete a project")?;
    let store = app
        .try_state::<ProjectStore>()
        .ok_or_else(|| "project store unavailable".to_string())?;
    let was_active = store.active().map(|p| p.id).as_deref() == Some(id);
    if !store.remove(id)? {
        return Err(format!("no project with id {id}"));
    }
    // Data-integrity #4: drop the deleted project's settings override so it can't
    // orphan in settings.json (best-effort — a persist failure here must not undo
    // the registry removal, so it's logged, not propagated).
    if let Err(e) = app
        .try_state::<crate::settings::SettingsStore>()
        .ok_or_else(|| "settings store unavailable".to_string())
        .and_then(|s| s.drop_project_override(id))
    {
        tracing::warn!(target: "nightcore::project", project_id = %id, error = %e, "failed to drop project settings override on delete");
    }
    // Custom Background: remove the deleted project's on-disk background bytes too
    // (its settings ref went with the override above). Best-effort — a leftover image
    // is harmless and must not undo the delete.
    if let Err(e) = crate::store::board_background::remove(app, id) {
        tracing::warn!(target: "nightcore::project", project_id = %id, error = %e, "failed to remove project board background on delete");
    }
    // Deleting the active project clears the board.
    if was_active {
        retarget_tasks(app, &store);
    }
    emit_project_event(app, &store, "deleted", None);
    Ok(())
}

/// Activate `id`: retarget the task store at its tasks dir, reload, and bump
/// `lastActiveAt`. Emits `nc:project { type: "activated" }`.
#[tauri::command]
pub async fn set_active_project(app: AppHandle, id: String) -> Result<Project, String> {
    // The heaviest registry command: `retarget_tasks` re-reads every JSON in the
    // task dir PLUS all 5 scan-store dirs, and `reconcile_worktrees` runs git
    // subprocess work (worktree list/prune/remove). Synchronous, that all ran on
    // the main thread and janked the UI on every project switch — run the body
    // on the blocking pool and merely await it.
    tauri::async_runtime::spawn_blocking(move || set_active_project_blocking(&app, &id))
        .await
        .map_err(|e| format!("set active project failed to run: {e}"))?
}

/// The blocking body of `set_active_project`, run off the UI thread. Managed
/// state is re-acquired from the owned `AppHandle` (a `State<'_, _>` guard can't
/// cross the thread boundary); `try_state` so an unmanaged store fails gracefully.
fn set_active_project_blocking(app: &AppHandle, id: &str) -> Result<Project, String> {
    // Single-flight: activate→retarget→reconcile is a multi-step check-and-act;
    // a rapid re-invoke (or a concurrent create/delete) must refuse, not
    // interleave and leave the stores pointed at a stale project.
    let _lease = acquire_registry_lease("switch projects")?;
    let store = app
        .try_state::<ProjectStore>()
        .ok_or_else(|| "project store unavailable".to_string())?;
    let project = store.set_active(id)?;
    retarget_tasks(app, &store);
    // Reconcile the newly-active project's worktrees: prune any whose task no
    // longer exists (the task store has just been retargeted to this project).
    crate::orchestration::coordinator::reconcile_worktrees(app);
    emit_project_event(app, &store, "activated", Some(&project));
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

/// Partial update for a project: optional `name` and/or Lucide `icon`. Setting
/// `icon` clears any custom image path (and removes the on-disk file). Emits
/// `nc:project { type: "updated" }`.
#[tauri::command]
pub fn update_project(
    app: AppHandle,
    store: State<'_, ProjectStore>,
    id: String,
    name: Option<String>,
    icon: Option<String>,
) -> Result<Project, String> {
    if let Some(ref n) = name {
        if n.trim().is_empty() {
            return Err("project name cannot be empty".to_string());
        }
    }
    let project = store.get(&id)?;
    if icon.is_some() {
        if let Some(ref rel) = project.custom_icon_path {
            if let Err(e) = crate::store::project_icon::remove_file(&project.path, rel) {
                tracing::warn!(target: "nightcore::project", project_id = %id, error = %e, "failed to remove custom icon on preset switch");
            }
        }
    }
    let name_ref = name.as_deref().map(str::trim);
    let icon_patch = icon.as_deref().map(Some);
    let updated = store.update(
        &id,
        name_ref,
        if icon.is_some() { icon_patch } else { None },
    )?;
    emit_project_event(&app, &store, "updated", Some(&updated));
    Ok(updated)
}

/// Set a Lucide preset icon on a project; clears any custom image. Emits `updated`.
#[tauri::command]
pub fn set_project_icon(
    app: AppHandle,
    store: State<'_, ProjectStore>,
    id: String,
    icon: String,
) -> Result<Project, String> {
    let project = store.get(&id)?;
    if let Some(ref rel) = project.custom_icon_path {
        if let Err(e) = crate::store::project_icon::remove_file(&project.path, rel) {
            tracing::warn!(target: "nightcore::project", project_id = %id, error = %e, "failed to remove custom icon on preset set");
        }
    }
    let updated = store.update(&id, None, Some(Some(&icon)))?;
    emit_project_event(&app, &store, "updated", Some(&updated));
    Ok(updated)
}

/// Persist a base64 custom icon under `.nightcore/images/` and point the project
/// at it. Clears any Lucide preset. Emits `updated`.
#[tauri::command]
pub async fn save_project_icon(
    app: AppHandle,
    id: String,
    format: String,
    data: String,
    filename: Option<String>,
) -> Result<Project, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_project_icon_blocking(&app, &id, &format, &data, filename.as_deref())
    })
    .await
    .map_err(|e| format!("save project icon failed to run: {e}"))?
}

fn save_project_icon_blocking(
    app: &AppHandle,
    id: &str,
    format: &str,
    data: &str,
    filename: Option<&str>,
) -> Result<Project, String> {
    let store = app
        .try_state::<ProjectStore>()
        .ok_or_else(|| "project store unavailable".to_string())?;
    let project = store.get(id)?;
    let rel = crate::store::project_icon::persist(&project.path, format, data, filename)?;
    if let Some(old) = project.custom_icon_path.as_deref() {
        if old != rel {
            let _ = crate::store::project_icon::remove_file(&project.path, old);
        }
    }
    let updated = store.set_custom_icon_path(id, &rel)?;
    emit_project_event(app, &store, "updated", Some(&updated));
    Ok(updated)
}

/// Remove custom icon bytes and clear both icon fields. Emits `updated`.
#[tauri::command]
pub fn clear_project_icon(
    app: AppHandle,
    store: State<'_, ProjectStore>,
    id: String,
) -> Result<Project, String> {
    let project = store.get(&id)?;
    if let Some(ref rel) = project.custom_icon_path {
        if let Err(e) = crate::store::project_icon::remove_file(&project.path, rel) {
            tracing::warn!(target: "nightcore::project", project_id = %id, error = %e, "failed to remove custom icon file on clear");
        }
    }
    let updated = store.clear_icon_fields(&id)?;
    emit_project_event(&app, &store, "updated", Some(&updated));
    Ok(updated)
}

/// Read a project's custom icon as a `data:` URL, or `None` when it has no custom
/// image (Lucide presets are rendered client-side).
#[tauri::command]
pub fn read_project_icon(
    store: State<'_, ProjectStore>,
    id: String,
) -> Result<Option<String>, String> {
    let project = store.get(&id)?;
    let rel = match project.custom_icon_path.as_deref() {
        Some(r) => r,
        None => return Ok(None),
    };
    Ok(Some(crate::store::project_icon::read_data_url(
        &project.path,
        rel,
    )?))
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
pub async fn git_init(path: String) -> Result<(), String> {
    // A git subprocess must not run on the main thread (WKWebView jank).
    tauri::async_runtime::spawn_blocking(move || git_init_blocking(&path))
        .await
        .map_err(|e| format!("git init failed to run: {e}"))?
}

/// The blocking body of `git_init`, run off the UI thread. Validation is
/// unchanged from the synchronous command; only the thread moved.
fn git_init_blocking(path: &str) -> Result<(), String> {
    // Validate before spawning: absolute, canonical, existing directory, and not
    // under a system root (this WRITES a `.git` into the target).
    let dir = validate_existing_dir(path)?;
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
    fn registry_lease_is_single_flight_and_releases_on_drop() {
        // The registry mutators (activate / create / delete) share ONE lease: a
        // second acquire while the first is held must refuse (no double-fire
        // under rapid re-invoke), and dropping the lease must re-open the gate
        // (RAII — an early `?` return still releases).
        let first = acquire_registry_lease("switch projects").expect("first acquire succeeds");
        let err = match acquire_registry_lease("delete a project") {
            Ok(_) => panic!("second concurrent acquire must refuse"),
            Err(e) => e,
        };
        assert!(
            err.contains("another project action is in progress"),
            "refusal names the contention: {err}"
        );
        drop(first);
        assert!(
            acquire_registry_lease("switch projects").is_ok(),
            "released lease re-acquires"
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
