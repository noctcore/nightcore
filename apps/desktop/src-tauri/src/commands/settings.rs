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

use tauri::{AppHandle, Manager, State};

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
    // Capture the resolved global provider before the merge so a change to the default
    // provider can drop the provider/auth-keyed model cache. Explicit task provider
    // picks still use the merged catalog; this clears stale fallback data for inherited
    // defaults. Only global patches touch `provider`.
    let provider_before = patch.project_id.is_none().then(|| store.get().provider);
    let merged = store.update(patch)?;
    if let Some(n) = resize {
        crate::orchestration::coordinator::set_max_concurrency(&app, n.max(1) as usize);
    }
    if let Some(before) = provider_before {
        if before != merged.provider {
            if let Some(cache) = app.try_state::<crate::store::ModelCache>() {
                cache.invalidate();
                tracing::info!(target: "nightcore", provider = %merged.provider, "provider changed; invalidated the model catalog cache");
            }
        }
    }
    Ok(merged)
}

/// The editors detected on this machine (CLI-first: a known-editor command
/// present on PATH), for the Settings "Open in editor" picker. Pure detection —
/// no store, no side effects. Async + `spawn_blocking`: each probe is a `which`
/// PATH walk, so the (bounded) filesystem scan stays off the WKWebView thread.
#[tauri::command]
pub async fn list_editors() -> Result<Vec<crate::infra::editor::DetectedEditor>, String> {
    tauri::async_runtime::spawn_blocking(crate::infra::editor::detect_editors)
        .await
        .map_err(|e| format!("list editors failed to run: {e}"))
}

// --- Custom Board Background -------------------------------------------------

/// Persist a project's custom board-background image (Custom Background feature) and
/// record its ref in that project's settings override, returning the merged settings
/// (the web refreshes its in-memory settings from the result). The image bytes are
/// format-, size-, and base64-validated server-side (see
/// [`crate::store::board_background`]) and written to OS app-data — NOT inline in
/// `settings.json` — before the ref is recorded, so a multi-MB gif never bloats the
/// shared settings file. Async + `spawn_blocking`: decoding/writing multi-MB bytes on
/// the main thread would briefly freeze the WKWebView (same reasoning as
/// `read_task_attachment`).
#[tauri::command]
pub async fn set_board_background(
    app: AppHandle,
    project_id: String,
    format: String,
    data: String,
) -> Result<Settings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_board_background_blocking(&app, &project_id, &format, &data)
    })
    .await
    .map_err(|e| format!("set board background failed to run: {e}"))?
}

fn set_board_background_blocking(
    app: &AppHandle,
    project_id: &str,
    format: &str,
    data: &str,
) -> Result<Settings, String> {
    let store = app
        .try_state::<SettingsStore>()
        .ok_or("settings store unavailable")?;
    // Remember the prior background's format so the rollback below can tell a
    // same-format overwrite (whose still-valid ref keeps pointing at the new bytes)
    // from a first-set / new-format write (safe to delete).
    let prior_format = store.board_background(project_id).map(|b| b.format);
    // Write the validated bytes atomically first; only record the ref if the write
    // succeeded. `persist` leaves any prior different-format file intact.
    let canonical = crate::store::board_background::persist(app, project_id, format, data)?;
    match store.set_board_background(project_id, canonical.clone()) {
        Ok(settings) => {
            // Committed: now (and only now) drop a stale different-format file left by
            // a replace, so exactly one background remains.
            crate::store::board_background::remove_other_formats(app, project_id, &canonical);
            Ok(settings)
        }
        Err(e) => {
            // Rollback the just-written bytes UNLESS they atomically overwrote a prior
            // background of the SAME format — in that case the prior ref still resolves
            // to a readable file, so deleting it would destroy the user's only image.
            // For a first set or a format change, the new file is an orphan (or the old
            // different-format file is still referenced), so remove just the new one.
            if prior_format.as_deref() != Some(canonical.as_str()) {
                let _ = crate::store::board_background::remove_format(app, project_id, &canonical);
            }
            Err(e)
        }
    }
}

/// Clear a project's custom board background: drop the settings ref and delete the
/// on-disk bytes, returning the merged settings. Idempotent (a project with no
/// background clears to a no-op).
#[tauri::command]
pub async fn clear_board_background(
    app: AppHandle,
    project_id: String,
) -> Result<Settings, String> {
    tauri::async_runtime::spawn_blocking(move || clear_board_background_blocking(&app, &project_id))
        .await
        .map_err(|e| format!("clear board background failed to run: {e}"))?
}

fn clear_board_background_blocking(app: &AppHandle, project_id: &str) -> Result<Settings, String> {
    let store = app
        .try_state::<SettingsStore>()
        .ok_or("settings store unavailable")?;
    // Drop the ref first (source of truth), then best-effort remove the bytes.
    let settings = store.clear_board_background(project_id)?;
    let _ = crate::store::board_background::remove(app, project_id);
    Ok(settings)
}

/// Read a project's custom board background as a `data:` URL for the board's CSS
/// `background-image`, or `None` when the project has no background set. Async +
/// `spawn_blocking`: reading + base64-encoding a multi-MB gif off the main thread
/// (same reasoning as `read_task_attachment`).
#[tauri::command]
pub async fn read_board_background(
    app: AppHandle,
    project_id: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_board_background_blocking(&app, &project_id))
        .await
        .map_err(|e| format!("read board background failed to run: {e}"))?
}

fn read_board_background_blocking(
    app: &AppHandle,
    project_id: &str,
) -> Result<Option<String>, String> {
    let store = app
        .try_state::<SettingsStore>()
        .ok_or("settings store unavailable")?;
    match store.board_background(project_id) {
        None => Ok(None),
        Some(bg) => {
            crate::store::board_background::read_data_url(app, project_id, &bg.format).map(Some)
        }
    }
}
