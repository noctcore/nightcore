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

use tauri::AppHandle;

use crate::store::harness_manifest::{
    read_policy_file, write_policy_patch, HarnessPolicyFile, HarnessPolicyPatch,
};

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
