//! The derived, in-memory per-provider model catalog cache (issue #80, B1).
//!
//! `list_models` (see [`crate::sidecar`]) serves the dynamic model catalog the web's
//! `/model` picker renders from. Re-fetching it on every keystroke would spin a fresh
//! engine probe each time — for Codex that means a `codex app-server` JSON-RPC round
//! trip — so the fetched catalog is cached here for a ~1h TTL, keyed per provider.
//!
//! ## Derived, never persisted
//!
//! This is DERIVED state: an in-memory map held in managed Tauri state (like
//! [`crate::workflow::pr_fix::PrFixRegistry`]), NOT a settings field. A restart starts
//! cold and the first `list_models` re-fetches — there is deliberately no
//! `settings.json` migration, because a stale on-disk catalog is worse than a cheap
//! re-fetch, and the catalog is a function of the provider + live auth, not user config.
//!
//! ## The `(catalog/provider scope, authState)` key
//!
//! The cache is keyed by BOTH the catalog/provider scope AND an opaque auth-state
//! fingerprint. The auth-state component is REQUIRED, not incidental: the Codex model
//! list is auth-FILTERED (the set of models `model/list` returns depends on the signed-in
//! account/plan), so caching by provider alone would serve one account's models to
//! another after a re-login. A different auth-state ⇒ a different key ⇒ a cache miss ⇒ a
//! re-fetch, so the cache self-invalidates across the provider dimension that changes
//! at runtime (auth). The command layer owns how each fingerprint is computed (Codex
//! reads its auth file's stamp; Claude is not auth-filtered
//! so its fingerprint is a constant) — this module stays a dumb, provider-agnostic
//! string-keyed TTL map.
//!
//! ## Fallback lives in the command layer
//!
//! This module intentionally does NOT know about `claude`/`codex` beyond the static
//! Claude catalog it derives from the contract enum (the sanctioned Claude fallback). The
//! per-provider empty-result policy (Claude → [`claude_static_catalog`]; Codex →
//! [`ModelCache::last_good`] else an honest error) is the command's job, so `store/` never
//! reaches up into the provider layer.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::{Mutex as AsyncMutex, MutexGuard as AsyncMutexGuard};

use crate::contracts::{EffortLevel, KnownModel, ModelDescriptor};

use super::settings::known_model_id;

/// How long a fetched catalog stays fresh before `list_models` re-fetches it. ~1 hour:
/// the model list changes on the order of provider releases, not minutes, so an hour
/// keeps the picker snappy without pinning a genuinely stale list for a whole session.
const MODEL_CACHE_TTL: Duration = Duration::from_secs(60 * 60);

/// The cache key: catalog/provider scope AND an opaque auth-state fingerprint. See the
/// module docs for why the auth-state component is required (the Codex list is
/// auth-filtered). Two keys are equal iff BOTH components match, so a re-login (new
/// fingerprint) is a natural cache miss.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ModelCacheKey {
    pub provider_id: String,
    pub auth_state: String,
}

impl ModelCacheKey {
    /// Build a key from the catalog/provider scope and its auth-state fingerprint.
    pub fn new(provider_id: impl Into<String>, auth_state: impl Into<String>) -> Self {
        Self {
            provider_id: provider_id.into(),
            auth_state: auth_state.into(),
        }
    }
}

/// One cached catalog entry: the fetched descriptors plus when they were fetched (for
/// the TTL check). Only ever non-empty (an empty fetch is never stored — see
/// [`ModelCache::store`]), so `last_good` can treat "present" as "usable".
struct CachedCatalog {
    models: Vec<ModelDescriptor>,
    fetched_at: Instant,
}

/// The per-provider model catalog cache — derived, in-memory, managed Tauri state.
///
/// Holds the keyed TTL map (behind a sync `Mutex`, only ever locked for the brief
/// read/clone/insert — never across an `.await`) plus a single-flight fetch lease (an
/// async `Mutex`): concurrent `list_models` calls that miss the cache serialize on the
/// lease so exactly one engine probe runs while the rest await its cached result, rather
/// than each firing its own expensive fetch.
#[derive(Default)]
pub struct ModelCache {
    entries: Mutex<HashMap<ModelCacheKey, CachedCatalog>>,
    fetch_lease: AsyncMutex<()>,
}

impl ModelCache {
    /// The FRESH (within-TTL), non-empty catalog cached for `key`, or `None` when there
    /// is no entry, it has expired, or it is empty. The fast path of `list_models`.
    pub fn fresh(&self, key: &ModelCacheKey) -> Option<Vec<ModelDescriptor>> {
        let entries = self.entries.lock().expect("model cache mutex poisoned");
        let entry = entries.get(key)?;
        if entry.models.is_empty() || entry.fetched_at.elapsed() >= MODEL_CACHE_TTL {
            return None;
        }
        Some(entry.models.clone())
    }

    /// The last cached-good (non-empty) catalog for `key` REGARDLESS of age — the Codex
    /// empty-result fallback: when a fresh fetch comes back empty, serve the last list we
    /// successfully fetched for this exact `(provider, auth)` rather than nothing. Returns
    /// `None` when we have never fetched a non-empty list for this key.
    pub fn last_good(&self, key: &ModelCacheKey) -> Option<Vec<ModelDescriptor>> {
        let entries = self.entries.lock().expect("model cache mutex poisoned");
        let entry = entries.get(key)?;
        if entry.models.is_empty() {
            return None;
        }
        Some(entry.models.clone())
    }

    /// Record a freshly-fetched catalog under `key`, stamping it now. An EMPTY list is
    /// never stored: an empty fetch is a failure/degraded signal, so keeping the last
    /// good list intact (for `last_good`) and letting the next call re-fetch is correct —
    /// caching empties would both suppress a live retry for an hour and clobber the
    /// fallback list.
    pub fn store(&self, key: ModelCacheKey, models: Vec<ModelDescriptor>) {
        if models.is_empty() {
            return;
        }
        self.entries
            .lock()
            .expect("model cache mutex poisoned")
            .insert(
                key,
                CachedCatalog {
                    models,
                    fetched_at: Instant::now(),
                },
            );
    }

    /// Drop every cached catalog. The explicit invalidation seam wired to a
    /// provider-config change (see `commands::settings::update_settings`); also the reset
    /// used by tests. Provider/auth changes ALSO self-invalidate via the key, so this is
    /// the belt to that suspenders.
    pub fn invalidate(&self) {
        self.entries
            .lock()
            .expect("model cache mutex poisoned")
            .clear();
    }

    /// Acquire the single-flight fetch lease. The caller holds the returned guard across
    /// its engine fetch so concurrent misses collapse onto one probe; each re-checks the
    /// cache after acquiring, since a prior holder may have just populated it.
    pub async fn fetch_lease(&self) -> AsyncMutexGuard<'_, ()> {
        self.fetch_lease.lock().await
    }
}

/// The static, `KnownModel`-derived Claude catalog — the sanctioned per-provider
/// empty-result fallback for the Claude provider (issue #80, item 4). This is NOT an
/// invented hardcoded catalog: the model VALUES come straight from the contract
/// `KnownModel` enum via [`known_model_id`] (the single source the zod spine owns), and
/// only the display metadata (name / one-line description / effort levels) is attached
/// here — exactly as the web's `apps/web/src/lib/models.ts` attaches its display metadata
/// to the same contract enum. It serves only as the honest stand-in when the engine's
/// live `listModels()` returns empty (e.g. the sidecar probe transiently failed); a
/// successful live fetch always supersedes it.
///
/// Exhaustive over `KnownModel`: adding a model to the contract enum without a metadata
/// row in [`claude_model_meta`] is a COMPILE error, mirroring the web's exhaustive
/// `Record<KnownModel, ModelMeta>`.
pub fn claude_static_catalog() -> Vec<ModelDescriptor> {
    const CATALOG: [KnownModel; 4] = [
        KnownModel::ClaudeOpus48,
        KnownModel::ClaudeSonnet46,
        KnownModel::ClaudeHaiku45,
        KnownModel::ClaudeFable5,
    ];
    CATALOG
        .into_iter()
        .map(|model| {
            let (display_name, description, supported_effort_levels) = claude_model_meta(model);
            ModelDescriptor {
                provider_id: Some("claude".to_string()),
                // Single-sourced from the contract enum — never a Rust string literal.
                value: known_model_id(model),
                display_name: display_name.to_string(),
                description: description.to_string(),
                // Every shipped Claude model honors the effort option; the SDK silently
                // downgrades any level a model can't serve, so an over-generous premium
                // set (xhigh/max on Opus/Fable) is safe.
                supports_effort: true,
                supported_effort_levels,
            }
        })
        .collect()
}

/// Display metadata for one `KnownModel` — the fallback stand-in for the live SDK
/// descriptor's `displayName` / `description` / `supportedEffortLevels`. Exhaustive match
/// (no wildcard) so a new contract model forces a metadata row here.
fn claude_model_meta(model: KnownModel) -> (&'static str, &'static str, Vec<EffortLevel>) {
    use EffortLevel::{High, Low, Max, Medium, Xhigh};
    match model {
        KnownModel::ClaudeOpus48 => (
            "Claude Opus 4.8",
            "Most capable — adaptive reasoning across long-horizon work.",
            vec![Low, Medium, High, Xhigh, Max],
        ),
        KnownModel::ClaudeSonnet46 => (
            "Claude Sonnet 4.6",
            "Balanced speed and depth.",
            vec![Low, Medium, High],
        ),
        KnownModel::ClaudeHaiku45 => (
            "Claude Haiku 4.5",
            "Fastest and most lightweight.",
            vec![Low, Medium, High],
        ),
        KnownModel::ClaudeFable5 => (
            "Claude Fable 5",
            "Creative generalist.",
            vec![Low, Medium, High, Xhigh, Max],
        ),
    }
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

    fn key() -> ModelCacheKey {
        ModelCacheKey::new("codex", "codex:1234:5678")
    }

    #[test]
    fn store_then_fresh_round_trips_a_non_empty_catalog() {
        let cache = ModelCache::default();
        let key = key();
        assert!(cache.fresh(&key).is_none(), "empty cache is a miss");
        cache.store(key.clone(), vec![descriptor("gpt-5")]);
        let hit = cache
            .fresh(&key)
            .expect("a fresh, non-empty entry is a hit");
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].value, "gpt-5");
    }

    #[test]
    fn store_never_caches_an_empty_list() {
        // An empty fetch must not be cached: it would suppress a live retry for the whole
        // TTL and clobber any last-good fallback list.
        let cache = ModelCache::default();
        let key = key();
        cache.store(key.clone(), vec![]);
        assert!(cache.fresh(&key).is_none());
        assert!(cache.last_good(&key).is_none());
    }

    #[test]
    fn last_good_ignores_ttl_but_fresh_would_not() {
        // `last_good` returns the stored non-empty list regardless of age (the Codex
        // empty-result fallback). We can't fast-forward the TTL here, but a just-stored
        // entry is returned by both — the age-independence is asserted by construction.
        let cache = ModelCache::default();
        let key = key();
        cache.store(key.clone(), vec![descriptor("gpt-5"), descriptor("o3")]);
        assert_eq!(cache.last_good(&key).unwrap().len(), 2);
    }

    #[test]
    fn a_different_auth_state_is_a_different_key() {
        // The crux of the auth-filtered requirement: the SAME provider under a NEW
        // auth-state must not see the old account's cached list.
        let cache = ModelCache::default();
        let signed_in = ModelCacheKey::new("codex", "codex:100:200");
        let after_relogin = ModelCacheKey::new("codex", "codex:100:999");
        cache.store(signed_in.clone(), vec![descriptor("gpt-5-pro")]);
        assert!(
            cache.fresh(&after_relogin).is_none(),
            "a new auth-state must miss the prior account's cached catalog"
        );
        assert!(cache.fresh(&signed_in).is_some());
    }

    #[test]
    fn invalidate_drops_every_entry() {
        let cache = ModelCache::default();
        let a = ModelCacheKey::new("claude", "n/a");
        let b = ModelCacheKey::new("codex", "codex:1:2");
        cache.store(a.clone(), vec![descriptor("claude-opus-4-8")]);
        cache.store(b.clone(), vec![descriptor("gpt-5")]);
        cache.invalidate();
        assert!(cache.fresh(&a).is_none());
        assert!(cache.fresh(&b).is_none());
    }

    #[test]
    fn claude_static_catalog_is_known_model_derived_and_exhaustive() {
        let catalog = claude_static_catalog();
        assert_eq!(catalog.len(), 4, "one descriptor per KnownModel variant");
        // Values are the contract ids (single-sourced), not invented strings.
        let ids: Vec<&str> = catalog.iter().map(|m| m.value.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "claude-opus-4-8",
                "claude-sonnet-4-6",
                "claude-haiku-4-5",
                "claude-fable-5",
            ]
        );
        // Every fallback descriptor is effort-capable with a non-empty level set, and the
        // premium models unlock the higher levels.
        assert!(catalog.iter().all(|m| m.supports_effort));
        assert!(catalog
            .iter()
            .all(|m| !m.supported_effort_levels.is_empty()));
        let opus = &catalog[0];
        assert!(opus.supported_effort_levels.contains(&EffortLevel::Max));
        assert!(!catalog[1]
            .supported_effort_levels
            .contains(&EffortLevel::Max));
    }
}
