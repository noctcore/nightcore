//! The `#[tauri::command]` entry point for the board's "Run checks" action.

use super::run::{empty_pass, run};
use super::GauntletResult;

/// Run the readiness gauntlet for a task on demand (the board's "Run checks"
/// action). Resolves the task's worktree under the active project; with no active
/// project or worktree it returns a trivially-passing empty result.
///
/// The body spawns the project's full typecheck/lint/test (bun) or cargo
/// check/clippy/test and BLOCKS on each — seconds to minutes. A synchronous
/// `#[tauri::command]` would run that on the main thread, freezing the WKWebView for
/// the whole duration (the "Run checks" lockup). Run it on the blocking pool and
/// merely await it, keeping the UI thread free — same pattern as `commit_task`.
#[tauri::command]
pub async fn run_gauntlet(app: tauri::AppHandle, id: String) -> Result<GauntletResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_gauntlet_blocking(&app, &id))
        .await
        .map_err(|e| format!("gauntlet failed to run: {e}"))?
}

/// The blocking body of `run_gauntlet`, run off the UI thread via `spawn_blocking`.
/// State is re-acquired via `try_state` (the `State<'_>` guard can't cross into the
/// 'static blocking closure) so an unmanaged store fails gracefully.
fn run_gauntlet_blocking(app: &tauri::AppHandle, id: &str) -> Result<GauntletResult, String> {
    use tauri::Manager;
    let store = app
        .try_state::<crate::store::TaskStore>()
        .ok_or("task store unavailable")?;
    store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;

    let Some(project) = app
        .try_state::<crate::project::ProjectStore>()
        .and_then(|s| s.active())
    else {
        return Ok(empty_pass());
    };
    let dir = crate::worktree::worktree_path(&std::path::PathBuf::from(&project.path), id);
    if !dir.exists() {
        return Ok(empty_pass());
    }
    Ok(run(&dir))
}
