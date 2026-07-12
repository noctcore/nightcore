//! The provider-capability command: `get_capabilities` (issue #18, B5).
//!
//! Serves the web a provider's [`ProviderCapabilities`] descriptor — the support
//! matrix the UI degrades from. Pass `provider_id` to describe a SPECIFIC provider
//! (the web primes one entry per known provider so `capabilitiesForProvider`
//! resolves synchronously); omit it (`None`) to describe the engine's DEFAULT
//! provider. The model picker's reasoning-effort row gates on `supportsEffort`, and
//! the scan surfaces' cost lines gate on `costTelemetry`, so a provider that lacks a
//! control (or reports no cost) hides that affordance instead of the UI branching on
//! the provider id.
//!
//! ## Why here (next to `provider_config` / `list_models`)
//!
//! The descriptor is provider-STATIC: the engine answers straight from the running
//! provider's own `capabilities()` (no SDK probe, no project dir), so this is a
//! cheap request/reply [`SurfaceQuery`] through the sidecar [`query`] transport —
//! the same shape as [`super::get_provider_config`] / [`super::list_models`], hence
//! it lives in `sidecar/` rather than `commands/`. The web falls back to a static
//! Claude descriptor outside Tauri (and fail-open on a failed read), so a missing
//! capability never silently drops a control.

use serde_json::Value;
use tauri::AppHandle;

use crate::contracts::{ProviderCapabilities, SurfaceQuery};

use super::query;

/// Read a provider's capability descriptor over the `get-capabilities` seam (engine
/// → the provider's own `capabilities()`). `provider_id` selects a specific provider;
/// `None` describes the engine's DEFAULT provider. Routes through the sidecar
/// [`query`] transport (which lazily spawns the child + its reader), so it also
/// starts the sidecar on first use; no project dir, since the descriptor is
/// provider-static.
#[tauri::command]
pub async fn get_capabilities(
    app: AppHandle,
    provider_id: Option<String>,
) -> Result<ProviderCapabilities, String> {
    let reply = query(
        &app,
        SurfaceQuery::GetCapabilities {
            // `requestId` is overwritten by `query` with a fresh uuid.
            request_id: String::new(),
            provider_id,
        },
    )
    .await?;
    if reply.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(reply
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("get-capabilities query failed")
            .to_string());
    }
    let capabilities = reply
        .get("capabilities")
        .ok_or("get-capabilities reply missing its descriptor")?;
    serde_json::from_value(capabilities.clone())
        .map_err(|e| format!("malformed provider capabilities from the engine: {e}"))
}
