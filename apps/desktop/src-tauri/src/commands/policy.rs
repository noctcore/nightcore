//! The harness policy authoring commands (the hardening catalog's policy UI seam).
//!
//! `.nightcore/harness.json`'s `policy` block is Rust-read/-written ONLY — never
//! model output. These commands give the web a typed read
//! (`get_harness_policy_file`) and a merge-by-key write
//! (`update_harness_policy_file`) over the ACTIVE project's manifest. The path is
//! always resolved server-side from the active project — never caller-supplied —
//! so the webview cannot point the writer at an arbitrary file. The reader/writer
//! themselves live in [`crate::store::harness_manifest`] (the single manifest
//! seam — audit #35); this module is the thin command shell the layer charter
//! (`commands/mod.rs`) calls for.
//!
//! `list_policy_activity` (issue #400) is the read-only third command: the
//! project's rails used to be invisible until the moment they parked a task, so
//! the authoring surface now reads the flight recorder back as a
//! why-denied-attributed feed. The aggregator lives in
//! [`crate::store::policy_activity`].

use tauri::AppHandle;

use crate::store::harness_manifest::{
    read_policy_file, write_policy_patch, HarnessPolicyFile, HarnessPolicyPatch,
};
use crate::store::policy_activity::{read_policy_activity, PolicyActivityEntry};

// --- Commands ---------------------------------------------------------------

/// The active project's path via `try_state` (blocking-pool safe: an unmanaged
/// store fails gracefully instead of panicking off the main thread).
fn active_project_path(app: &AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let projects = app
        .try_state::<crate::project::ProjectStore>()
        .ok_or_else(|| "project store unavailable".to_string())?;
    projects
        .active()
        .map(|p| p.path)
        .ok_or_else(|| "no active project".to_string())
}

/// Read the ACTIVE project's harness policy block for the editor UI. Async +
/// `spawn_blocking`: file IO must not stall the WKWebView (same posture as
/// `scan_injection_surface`).
#[tauri::command]
pub async fn get_harness_policy_file(app: AppHandle) -> Result<HarnessPolicyFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = active_project_path(&app)?;
        Ok(read_policy_file(&path))
    })
    .await
    .map_err(|e| format!("policy read failed to run: {e}"))?
}

/// The ACTIVE project's recent gate decisions (deny/ask), newest first — the
/// Policy activity feed (issue #400).
///
/// Read-only: it aggregates the flight-recorder ledgers the engine already wrote
/// and never touches the manifest. The project root is resolved server-side from
/// the active project (never caller-supplied), so the webview cannot point the
/// reader at an arbitrary directory. Task titles are resolved through the task
/// store for legibility; a task deleted since its session keeps its evidence
/// without a title. Async + `spawn_blocking`: it reads one file per task, which
/// must not stall the WKWebView (`reference_tauri_command_threading`).
#[tauri::command]
pub async fn list_policy_activity(app: AppHandle) -> Result<Vec<PolicyActivityEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let root = active_project_path(&app)?;
        let dir = crate::store::ledger::ledger_dir(std::path::Path::new(&root));
        // `try_state` inside the blocking closure (the `State<'_>` guard cannot
        // cross into it); an unmanaged store degrades to untitled rows rather
        // than dropping the feed.
        let tasks = app.try_state::<crate::store::TaskStore>();
        let resolve = |task_id: &str| {
            tasks
                .as_ref()
                .and_then(|store| store.get(task_id))
                .map(|task| task.title)
        };
        Ok(read_policy_activity(&dir, &resolve))
    })
    .await
    .map_err(|e| format!("policy activity read failed to run: {e}"))?
}

/// Merge a policy patch into the ACTIVE project's `.nightcore/harness.json`
/// (creating it when absent) and return the updated policy. The target path is
/// resolved server-side — never caller-supplied.
#[tauri::command]
pub async fn update_harness_policy_file(
    app: AppHandle,
    patch: HarnessPolicyPatch,
) -> Result<HarnessPolicyFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = active_project_path(&app)?;
        write_policy_patch(&path, &patch)
    })
    .await
    .map_err(|e| format!("policy write failed to run: {e}"))?
}
