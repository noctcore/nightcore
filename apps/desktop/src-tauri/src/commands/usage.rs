//! The provider usage-meter command surface (issue #121) — thin async handlers over
//! [`crate::usage::UsageRegistry`] (managed state) + the `SettingsStore` opt-in flag.
//!
//! ALL async + `spawn_blocking` (a sync `#[tauri::command]` runs on the WKWebView
//! main thread and can freeze the UI — the known trap,
//! `reference_tauri_command_threading`; every terminal/trust command follows this).
//! State is re-acquired via `app.try_state()` inside each spawned block.
//!
//! USER-ONLY (spec §2): these commands are invokable only from the webview; no
//! agent/sidecar path reaches the meter.

use tauri::{AppHandle, Emitter, Manager};

use crate::settings::{SettingsPatch, SettingsStore};
use crate::usage::contract::{UsageCost, UsageMeter};
use crate::usage::{arm, kick, prime_credentials, UsageRegistry, REFRESH_MIN_AGE, USAGE_EVENT};

/// Opt in (spec decision 5): (a) flip the persisted `usage_meter_enabled` flag,
/// (b) perform the FIRST credential read so the macOS Keychain prompt fires as a
/// consequence of THIS click, (c) arm the recurring poll loop. Returns the current
/// snapshot (the first real windows arrive shortly over `nc:usage`). If the user
/// denies the Keychain prompt, the provider resolves to `Unauthorized`/`NotConnected`
/// — never a crash.
///
/// Also PUSHES that same snapshot over `nc:usage` (issue #305): the return value
/// only reaches the caller (e.g. the Settings toggle), but other mounted surfaces
/// (the sidebar widget) only ever render off the push — without this, an enable
/// triggered from Settings never reached the sidebar until the next 10-min poll.
#[tauri::command]
pub async fn enable_usage_meter(app: AppHandle) -> Result<UsageMeter, String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_enabled(&app, true)?;
        // The credential read that fires the Keychain prompt (on the blocking pool —
        // a prompt may block). Result discarded; the loop does the real fetch.
        prime_credentials();
        // Arm (or wake) the loop; it polls immediately now that the flag is on.
        arm(&app);
        let reg = app
            .try_state::<UsageRegistry>()
            .ok_or("usage registry unavailable")?;
        let snapshot = reg.snapshot();
        let _ = app.emit(USAGE_EVENT, snapshot.clone());
        Ok(snapshot)
    })
    .await
    .map_err(|e| format!("enable usage meter failed to run: {e}"))?
}

/// Opt out: flip the flag off + wake the loop so it re-checks and parks (spending
/// zero network while disabled).
///
/// Also PUSHES a fresh `disabled_meter()` snapshot over `nc:usage` (issue #305): the
/// poll loop only parks silently on its own kick (`poller::run_loop`) — it never
/// emits on the disable path — so without this push, a surface that renders purely
/// off the `nc:usage` snapshot (the sidebar widget) stayed showing live data until
/// the next relaunch, even though the meter had just been turned off.
#[tauri::command]
pub async fn disable_usage_meter(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_enabled(&app, false)?;
        kick(&app);
        let _ = app.emit(USAGE_EVENT, UsageRegistry::disabled_meter());
        Ok(())
    })
    .await
    .map_err(|e| format!("disable usage meter failed to run: {e}"))?
}

/// The last-good snapshot (the fetch-on-mount source of truth; no fetch here).
/// Returns a `Disabled`-status meter when opt-in-off, so the widget renders its
/// "Enable usage meter" state.
#[tauri::command]
pub async fn get_usage(app: AppHandle) -> Result<UsageMeter, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_enabled(&app) {
            return Ok(UsageRegistry::disabled_meter());
        }
        let reg = app
            .try_state::<UsageRegistry>()
            .ok_or("usage registry unavailable")?;
        Ok(reg.snapshot())
    })
    .await
    .map_err(|e| format!("get usage failed to run: {e}"))?
}

/// Kick a fresh poll (the web `window` focus listener). Single-flight-guarded, and
/// internally no-ops unless the snapshot is ≥ 10 min old (spec §3.3 staleness guard)
/// so a focus-storm can't hammer the endpoints.
#[tauri::command]
pub async fn refresh_usage(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(reg) = app.try_state::<UsageRegistry>() {
            if is_enabled(&app) && reg.stale_enough(REFRESH_MIN_AGE) {
                kick(&app);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("refresh usage failed to run: {e}"))?
}

/// The on-demand local cost ESTIMATE for a provider (spec §3.8) — invoked when the
/// detail popover opens. `spawn_blocking` (a whole-tree JSONL read). Always labeled
/// approximate in the result.
#[tauri::command]
pub async fn get_usage_cost(app: AppHandle, provider: String) -> Result<UsageCost, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let reg = app
            .try_state::<UsageRegistry>()
            .ok_or("usage registry unavailable")?;
        Ok(reg.cost(&provider))
    })
    .await
    .map_err(|e| format!("get usage cost failed to run: {e}"))?
}

/// Flip the persisted `usage_meter_enabled` flag via the settings store.
fn set_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let store = app
        .try_state::<SettingsStore>()
        .ok_or("settings store unavailable")?;
    store.update(SettingsPatch {
        usage_meter_enabled: Some(enabled),
        ..Default::default()
    })?;
    Ok(())
}

/// Whether the meter is opt-in-on. `false` when the settings store isn't managed.
fn is_enabled(app: &AppHandle) -> bool {
    app.try_state::<SettingsStore>()
        .map(|s| s.with_settings(|s| s.usage_meter_enabled))
        .unwrap_or(false)
}
