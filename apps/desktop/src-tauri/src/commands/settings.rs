//! The settings command handlers.
//!
//! The `#[tauri::command]` handlers over the
//! [`SettingsStore`](crate::settings::SettingsStore), registered in `lib.rs` as
//! `commands::settings::*` and invoked from the webview. They sit ABOVE the
//! persistence layer: `get_settings`/`update_settings` go through the store
//! (persist), and a global `maxConcurrency` change up-calls
//! [`crate::orchestration`] to resize the live slot pool — which is why these
//! handlers live in this command layer rather than in the `store/settings`
//! persistence leaf. `app_info` returns build-time metadata for the About page.

use tauri::{AppHandle, State};

use crate::settings::{AppInfo, Settings, SettingsPatch, SettingsStore, REPOSITORY_URL};

// --- Commands ---------------------------------------------------------------

/// Real application metadata for the About page (version + repo URL), sourced from
/// build-time constants rather than UI literals.
#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        repository: REPOSITORY_URL.to_string(),
    }
}

/// The current settings (global + per-project overrides).
#[tauri::command]
pub fn get_settings(store: State<'_, SettingsStore>) -> Result<Settings, String> {
    Ok(store.get())
}

/// Shallow-merge a patch into the global block, or — when `projectId` is set —
/// into that project's override. Returns the merged settings. A global
/// `maxConcurrency` change is also applied to the live slot pool so the auto-loop
/// honors it immediately (not just on next launch).
#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    patch: SettingsPatch,
) -> Result<Settings, String> {
    // A global (no projectId) maxConcurrency change resizes the live pool.
    let resize = patch
        .project_id
        .is_none()
        .then_some(patch.max_concurrency)
        .flatten();
    let merged = store.update(patch)?;
    if let Some(n) = resize {
        crate::orchestration::coordinator::set_max_concurrency(&app, n.max(1) as usize);
    }
    Ok(merged)
}
