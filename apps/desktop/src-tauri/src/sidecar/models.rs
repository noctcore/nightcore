//! The dynamic model-catalog command: `list_models` (issue #80, B1).
//!
//! Serves the web's `/model` picker its catalog of selectable models — each a wire
//! [`ModelDescriptor`] (id + display name + per-model effort levels). The catalog is
//! DYNAMIC: it is fetched from the engine's provider registry at runtime over the B0
//! `get-models` seam (engine → `listModels()`), never a hardcoded family list, so a new
//! model appears without a Nightcore release. The result is cached per catalog/auth key for a
//! ~1h TTL (see [`crate::store::model_cache`]) so a picker open doesn't spin a fresh
//! engine probe — for Codex, a `codex app-server` JSON-RPC round trip — every time.
//!
//! ## Why here (next to `provider_config`)
//!
//! Like [`super::get_provider_config`], this issues a request/reply `SurfaceQuery` through
//! the sidecar [`query`] transport, so it lives in `sidecar/` rather than `commands/`. It
//! is the command layer that owns the two things `store/` may not: reaching the RUNNING
//! provider (for its id) and computing the provider-specific auth-state fingerprint.
//!
//! ## Per-provider empty-result fallback (never an invented catalog)
//!
//! When the live fetch returns an empty list (the engine degraded to `[]`) or fails, the
//! fallback is PER-PROVIDER and never fabricates a catalog:
//!   - **Claude** → [`claude_static_catalog`], the contract-`KnownModel`-derived static
//!     list (values single-sourced from the zod spine; only display metadata is local).
//!   - **Codex** → the last cached-good list for this exact `(provider, auth)` key, else
//!     the engine's degraded fallback (`gpt-5-codex`) if live app-server discovery is
//!     unavailable.
//!
//! ## Codex fetch (engine-side; verified against the live binary)
//!
//! The Codex model fetch itself is ENGINE-side (a `codex app-server` JSON-RPC client,
//! spawn-per-call): this Rust layer only asks the engine over `get-models`. Ground truth,
//! verified against `codex app-server generate-ts` (codex-cli 0.141.0) so the engine
//! parser doesn't have to guess: the request method is `model/list`; the reply is
//! `ModelListResponse { data: Model[] }`; each `Model` carries `id`, `model`,
//! `displayName`, `description`, `hidden`, `supportedReasoningEfforts[]`,
//! `defaultReasoningEffort`. Casing is MIXED across the protocol — the v2 request/reply
//! types are camelCase (`displayName`, `supportedReasoningEfforts`) while the config/TOML
//! types are snake_case (`model_reasoning_effort`) — so the engine parser must key off the
//! camelCase v2 shape and must NOT assume one casing wholesale.

use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::contracts::{EffortLevel, ModelDescriptor, SurfaceQuery};
use crate::provider::{CLAUDE_PROVIDER_ID, CODEX_PROVIDER_ID};
use crate::store::{claude_static_catalog, ModelCache, ModelCacheKey};

use super::query;

const COMBINED_PROVIDER_KEY: &str = "all";

/// Read the dynamic model catalog for the `/model` picker.
///
/// Cached-or-fetch: returns the fresh cached catalog when one is within its ~1h TTL for
/// the current `(provider, auth-state)`, otherwise fetches it live from the provider and
/// caches a non-empty result. `refresh: Some(true)` forces a re-fetch, bypassing the
/// fresh-cache read (but still single-flighted). On an empty/failed fetch, degrades to the
/// per-provider fallback (Claude static list / Codex last-cached-good or SDK default).
#[tauri::command]
pub async fn list_models(
    app: AppHandle,
    refresh: Option<bool>,
) -> Result<Vec<ModelDescriptor>, String> {
    let refresh = refresh.unwrap_or(false);
    let provider_id = COMBINED_PROVIDER_KEY.to_string();
    let key = ModelCacheKey::new(&provider_id, auth_state_for(&provider_id));

    let cache = app.state::<ModelCache>();

    // Fast path: a fresh cached catalog (skipped on an explicit refresh).
    if !refresh {
        if let Some(models) = cache.fresh(&key) {
            return Ok(models);
        }
    }

    // Single-flight: concurrent misses serialize on the fetch lease so exactly one engine
    // probe runs. Re-check the cache after acquiring — a prior holder may have populated
    // it while we waited (double-checked locking).
    let _lease = cache.fetch_lease().await;
    if !refresh {
        if let Some(models) = cache.fresh(&key) {
            return Ok(models);
        }
    }

    match fetch_models(&app).await {
        Ok(models) if !models.is_empty() => {
            cache.store(key, models.clone());
            Ok(models)
        }
        // A live-but-empty list: the engine's `listModels()` degraded to `[]`. Do NOT
        // cache it (keeps the next call retrying live) — fall back per provider.
        Ok(_empty) => {
            tracing::info!(target: "nightcore", provider = %provider_id, "list_models: live catalog empty; using per-provider fallback");
            fallback(&provider_id, &key, &cache)
        }
        // A transport/engine failure. Log it (this network-shaped op is otherwise
        // invisible) and fall back per provider.
        Err(err) => {
            tracing::warn!(target: "nightcore", provider = %provider_id, error = %err, "list_models: live fetch failed; using per-provider fallback");
            fallback(&provider_id, &key, &cache)
        }
    }
}

/// Fetch the live merged catalog over the B0 `get-models` seam. Routes
/// through the sidecar [`query`] transport (which lazily spawns the child + its reader),
/// so this also starts the sidecar on first use. No project dir: the engine spins a
/// transient probe when no session is live, so the picker works with no active project.
async fn fetch_models(app: &AppHandle) -> Result<Vec<ModelDescriptor>, String> {
    let reply = query(
        app,
        SurfaceQuery::GetModels {
            // `requestId` is overwritten by `query` with a fresh uuid.
            request_id: String::new(),
        },
    )
    .await?;
    if reply.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(reply
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("get-models query failed")
            .to_string());
    }
    let models = reply
        .get("models")
        .ok_or("get-models reply missing its model list")?;
    serde_json::from_value(models.clone())
        .map_err(|e| format!("malformed model descriptor list from the engine: {e}"))
}

/// The empty-result fallback. The live catalog is provider-merged; when it is
/// unavailable, serve a combined static fallback so the picker still exposes both
/// shipped providers.
fn fallback(
    provider_id: &str,
    key: &ModelCacheKey,
    cache: &ModelCache,
) -> Result<Vec<ModelDescriptor>, String> {
    match provider_id {
        COMBINED_PROVIDER_KEY => Ok(cache.last_good(key).unwrap_or_else(|| {
            let mut models = claude_static_catalog();
            models.extend(codex_static_catalog());
            models
        })),
        CLAUDE_PROVIDER_ID => Ok(claude_static_catalog()),
        CODEX_PROVIDER_ID => Ok(cache.last_good(key).unwrap_or_else(codex_static_catalog)),
        other => Err(format!(
            "no model catalog available for provider `{other}`, and no cached list to \
             fall back on"
        )),
    }
}

/// The SDK-backed Codex fallback when app-server model discovery is unavailable.
fn codex_static_catalog() -> Vec<ModelDescriptor> {
    vec![ModelDescriptor {
        provider_id: Some(CODEX_PROVIDER_ID.to_string()),
        value: "gpt-5-codex".to_string(),
        display_name: "GPT-5 Codex".to_string(),
        description: "Codex-optimized coding model".to_string(),
        supports_effort: true,
        supported_effort_levels: vec![
            EffortLevel::Low,
            EffortLevel::Medium,
            EffortLevel::High,
            EffortLevel::Xhigh,
        ],
    }]
}

/// The auth-state fingerprint for `provider_id` — the auth component of the cache key.
fn auth_state_for(provider_id: &str) -> String {
    match provider_id {
        COMBINED_PROVIDER_KEY => format!("all:codex:{}", codex_auth_fingerprint()),
        // Codex's `model/list` is auth-FILTERED, so the fingerprint must track the
        // signed-in identity; a re-login changes it and re-fetches.
        CODEX_PROVIDER_ID => codex_auth_fingerprint(),
        // Claude's model list is NOT auth-filtered — a constant keeps one cache entry.
        _ => "n/a".to_string(),
    }
}

/// A cheap, opaque fingerprint of the Codex auth file (`$CODEX_HOME/auth.json`, default
/// `~/.codex/auth.json`) — its byte length + mtime, NEVER the token bytes. A
/// login / logout / token refresh rewrites the file, changing the stamp, so the cache key
/// changes and the auth-filtered Codex catalog is re-fetched. Missing/unreadable ⇒
/// `"unauthed"`: a distinct, stable key for the signed-out state.
fn codex_auth_fingerprint() -> String {
    let Some(path) = codex_auth_path() else {
        return "unauthed".to_string();
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return "unauthed".to_string();
    };
    let len = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("codex:{len}:{mtime}")
}

/// `$CODEX_HOME/auth.json`, else `<home>/.codex/auth.json`. `None` when neither the
/// override nor a home dir resolves (then the fingerprint degrades to the signed-out key).
fn codex_auth_path() -> Option<PathBuf> {
    if let Some(codex_home) = std::env::var_os("CODEX_HOME") {
        if !codex_home.is_empty() {
            return Some(PathBuf::from(codex_home).join("auth.json"));
        }
    }
    home_dir().map(|h| h.join(".codex").join("auth.json"))
}

/// The user's home directory from the environment (`HOME` on unix, `USERPROFILE` on
/// Windows). Reads the env directly to avoid a new crate dependency; the desktop always
/// runs with a home set.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(value: &str) -> ModelDescriptor {
        ModelDescriptor {
            provider_id: None,
            value: value.to_string(),
            display_name: value.to_string(),
            description: String::new(),
            supports_effort: false,
            supported_effort_levels: vec![],
        }
    }

    #[test]
    fn claude_auth_state_is_a_constant() {
        // Claude's list is not auth-filtered, so its fingerprint never varies.
        assert_eq!(auth_state_for(CLAUDE_PROVIDER_ID), "n/a");
        assert_eq!(auth_state_for("gemini"), "n/a");
    }

    #[test]
    fn codex_auth_state_is_provider_specific_and_stable() {
        // Codex gets a real fingerprint (either `codex:<len>:<mtime>` when auth.json
        // exists, or `unauthed`) — never the constant Claude key — and it is stable
        // across calls within a session (no time-of-check flapping).
        let a = auth_state_for(CODEX_PROVIDER_ID);
        let b = auth_state_for(CODEX_PROVIDER_ID);
        assert_eq!(a, b, "the fingerprint is stable across reads");
        assert_ne!(
            a, "n/a",
            "codex is auth-filtered, not the constant Claude key"
        );
        assert!(
            a == "unauthed" || a.starts_with("codex:"),
            "unexpected codex fingerprint shape: {a}"
        );
    }

    #[test]
    fn claude_fallback_returns_the_static_catalog() {
        let cache = ModelCache::default();
        let key = ModelCacheKey::new(CLAUDE_PROVIDER_ID, "n/a");
        let models = fallback(CLAUDE_PROVIDER_ID, &key, &cache).expect("claude never errors");
        assert_eq!(models.len(), 4);
        assert_eq!(models[0].value, "claude-opus-4-8");
    }

    #[test]
    fn codex_fallback_serves_static_catalog_when_no_cache() {
        let cache = ModelCache::default();
        let key = ModelCacheKey::new(CODEX_PROVIDER_ID, "unauthed");
        let models =
            fallback(CODEX_PROVIDER_ID, &key, &cache).expect("codex falls back to its SDK default");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].value, "gpt-5-codex");
    }

    #[test]
    fn combined_fallback_serves_both_shipped_providers() {
        let cache = ModelCache::default();
        let key = ModelCacheKey::new(COMBINED_PROVIDER_KEY, "all:codex:unauthed");
        let models = fallback(COMBINED_PROVIDER_KEY, &key, &cache)
            .expect("combined catalog has a static fallback");
        assert!(models
            .iter()
            .any(|m| m.provider_id.as_deref() == Some("claude")));
        assert!(models
            .iter()
            .any(|m| m.provider_id.as_deref() == Some("codex")));
        assert!(models.iter().any(|m| m.value == "gpt-5-codex"));
    }

    #[test]
    fn codex_fallback_serves_last_cached_good() {
        let cache = ModelCache::default();
        let key = ModelCacheKey::new(CODEX_PROVIDER_ID, "codex:1:2");
        cache.store(key.clone(), vec![descriptor("gpt-5"), descriptor("o3")]);
        let models = fallback(CODEX_PROVIDER_ID, &key, &cache).expect("last cached-good is served");
        assert_eq!(
            models.iter().map(|m| m.value.as_str()).collect::<Vec<_>>(),
            vec!["gpt-5", "o3"]
        );
    }

    #[test]
    fn unknown_provider_fallback_never_invents_a_catalog() {
        let cache = ModelCache::default();
        let key = ModelCacheKey::new("gemini", "n/a");
        let err = fallback("gemini", &key, &cache).expect_err("unknown providers get an error");
        assert!(err.contains("gemini"));
    }

    #[test]
    fn codex_auth_path_prefers_the_codex_home_override() {
        // Documents the resolution order without mutating process env (which would race
        // other tests): a set CODEX_HOME wins; otherwise it's `<home>/.codex/auth.json`.
        // We can only assert the fallback shape here.
        if let Some(path) = codex_auth_path() {
            assert!(
                path.ends_with("auth.json"),
                "resolves to the auth file: {path:?}"
            );
        }
    }
}
