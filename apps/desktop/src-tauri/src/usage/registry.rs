//! The usage-meter managed state: the last-good [`UsageMeter`] snapshot, the
//! per-provider 429 cooldowns, the popover cost cache, and the poll-loop lifecycle
//! primitives (arm flag + kick `Notify`). Mirrors `terminal::TerminalRegistry` and
//! the derived-in-memory `store::model_cache::ModelCache` — held in memory only (v1,
//! spec §3.2), so a restart starts cold and the first poll refills it. This dodges
//! the entire persisted-credential risk surface (spec decision 4 / §3.7).
//!
//! State transitions here are the FAIL-SOFT machine (spec §3.6): every fetch outcome
//! maps to a defined [`UsageStatus`] that keeps the last-good windows where the spec
//! says to, and NOTHING here panics or blanks a row.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::Notify;

use crate::infra::time::iso8601_utc;
use crate::task::now_ms;
use crate::usage::contract::{ProviderUsage, UsageCost, UsageMeter, UsageStatus};
use crate::usage::cost::CostCache;
use crate::usage::http::{FetchError, ParsedUsage, DEFAULT_COOLDOWN};

/// The providers the meter tracks, in stable render order (spec decision 3).
pub(crate) const PROVIDERS: &[&str] = &["claude", "codex"];

/// The re-auth guidance surfaced on a 401 — OUR OWN trusted text (spec decision 4:
/// NEVER refresh a token; tell the user to re-sign-in via their CLI).
const REAUTH_MESSAGE: &str = "session expired — run `claude` / `codex` to re-sign-in";

/// Managed state for the usage meter.
pub struct UsageRegistry {
    meter: Mutex<UsageMeter>,
    cost_cache: CostCache,
    cooldowns: Mutex<HashMap<String, Instant>>,
    /// The instant the last poll batch touched a provider — the staleness input for
    /// the focus-refetch guard (spec §3.3). `None` before any poll.
    last_poll: Mutex<Option<Instant>>,
    armed: AtomicBool,
    kick: Notify,
}

impl Default for UsageRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl UsageRegistry {
    /// A cold registry: one dormant `NotConnected` row per provider so the widget
    /// layout is stable before the first poll.
    pub fn new() -> Self {
        Self {
            meter: Mutex::new(UsageMeter {
                providers: PROVIDERS
                    .iter()
                    .map(|p| ProviderUsage::not_connected(p))
                    .collect(),
                updated_at: None,
            }),
            cost_cache: CostCache::default(),
            cooldowns: Mutex::new(HashMap::new()),
            last_poll: Mutex::new(None),
            armed: AtomicBool::new(false),
            kick: Notify::new(),
        }
    }

    /// A clone of the last-good snapshot (the `get_usage` source of truth + the
    /// `nc:usage` push payload).
    pub(crate) fn snapshot(&self) -> UsageMeter {
        crate::sync::lock_or_recover(&self.meter).clone()
    }

    /// A synthesized `Disabled` meter (opt-in-off, spec decision 5) — every provider
    /// row in its dormant "Enable" state, without touching the stored snapshot.
    pub(crate) fn disabled_meter() -> UsageMeter {
        UsageMeter {
            providers: PROVIDERS
                .iter()
                .map(|p| ProviderUsage::disabled(p))
                .collect(),
            updated_at: None,
        }
    }

    /// The kick `Notify` — the loop selects on `kick().notified()`, the enable /
    /// refresh commands call [`notify`](Self::notify).
    pub(crate) fn kick(&self) -> &Notify {
        &self.kick
    }

    /// Wake the poll loop (coalesced: a kick during a poll is remembered for the
    /// next select, never stacked into a second concurrent batch).
    pub(crate) fn notify(&self) {
        self.kick.notify_one();
    }

    /// Try to claim the arm flag; returns `true` if THIS caller armed it (the loop
    /// should be spawned), `false` if it was already armed (idempotent).
    pub(crate) fn try_arm(&self) -> bool {
        !self.armed.swap(true, Ordering::SeqCst)
    }

    /// Whether the loop task is armed (spawned). Test-only assertion helper.
    #[cfg(test)]
    pub(crate) fn is_armed(&self) -> bool {
        self.armed.load(Ordering::SeqCst)
    }

    /// Whether the snapshot is at least `min_age` old (or was never polled) — the
    /// `refresh_usage` focus guard kicks a poll only when this is true, so a
    /// focus-storm can't hammer the endpoints (spec §3.3).
    pub(crate) fn stale_enough(&self, min_age: Duration) -> bool {
        match *crate::sync::lock_or_recover(&self.last_poll) {
            None => true,
            Some(last) => last.elapsed() >= min_age,
        }
    }

    /// The approximate popover cost for `provider` (spec §3.8) — cached by mtime.
    pub(crate) fn cost(&self, provider: &str) -> UsageCost {
        self.cost_cache.compute(provider)
    }

    /// Whether `provider` is inside its 429 cooldown (skip the fetch, keep last-good).
    pub(crate) fn in_cooldown(&self, provider: &str) -> bool {
        crate::sync::lock_or_recover(&self.cooldowns)
            .get(provider)
            .is_some_and(|until| Instant::now() < *until)
    }

    // --- Fail-soft state transitions (spec §3.6) --------------------------------

    /// A successful fetch: fresh windows + credits, status `Ok`, stamps updated_at.
    pub(crate) fn mark_ok(&self, provider: &str, parsed: ParsedUsage) {
        let now = iso8601_utc(now_ms());
        self.update(provider, |row| {
            row.status = UsageStatus::Ok;
            row.windows = parsed.windows;
            row.credits = parsed.credits;
            row.stale = false;
            row.message = None;
            row.updated_at = Some(now.clone());
        });
    }

    /// Map a [`FetchError`] onto the row's degraded state (keeping last-good windows
    /// where the spec requires) + arm a cooldown on 429.
    pub(crate) fn apply_error(&self, provider: &str, err: FetchError) {
        match err {
            FetchError::NoCreds => self.set_status(provider, UsageStatus::NotConnected, None, true),
            FetchError::Unauthorized => self.set_status(
                provider,
                UsageStatus::Unauthorized,
                Some(REAUTH_MESSAGE.to_string()),
                true,
            ),
            FetchError::RateLimited { retry_after } => {
                self.set_cooldown(provider, retry_after.unwrap_or(DEFAULT_COOLDOWN));
                self.set_status(
                    provider,
                    UsageStatus::RateLimited,
                    Some("rate-limited — retrying shortly".to_string()),
                    false,
                );
            }
            FetchError::Unsupported(msg) => {
                self.set_status(provider, UsageStatus::Unsupported, Some(msg), false)
            }
            FetchError::Transient(msg) => {
                tracing::warn!(target: "nightcore::usage", provider, reason = %msg, "usage fetch degraded (transient)");
                self.set_status(provider, UsageStatus::Stale, None, false)
            }
        }
    }

    /// Arm a per-provider cooldown (honored by [`in_cooldown`](Self::in_cooldown)).
    fn set_cooldown(&self, provider: &str, dur: Duration) {
        if let Some(until) = Instant::now().checked_add(dur) {
            crate::sync::lock_or_recover(&self.cooldowns).insert(provider.to_string(), until);
        }
    }

    /// Set a row's status + message, marking it stale (showing last-good). When
    /// `clear_windows` is set (NotConnected / Unauthorized) the bars are dropped —
    /// those states render a dormant / re-auth row, not a bar.
    fn set_status(
        &self,
        provider: &str,
        status: UsageStatus,
        message: Option<String>,
        clear_windows: bool,
    ) {
        self.update(provider, |row| {
            row.status = status;
            row.stale = true;
            row.message = message.clone();
            if clear_windows {
                row.windows.clear();
                row.credits = None;
            }
        });
    }

    /// Apply `f` to the named provider's row (a no-op if the provider is unknown),
    /// then bump the meter-level `updated_at` to now (this poll touched a provider).
    fn update(&self, provider: &str, f: impl FnOnce(&mut ProviderUsage)) {
        let mut meter = crate::sync::lock_or_recover(&self.meter);
        if let Some(row) = meter.providers.iter_mut().find(|r| r.provider == provider) {
            f(row);
        }
        meter.updated_at = Some(iso8601_utc(now_ms()));
        drop(meter);
        *crate::sync::lock_or_recover(&self.last_poll) = Some(Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::contract::RateWindow;

    fn window(kind: &str, pct: f64) -> RateWindow {
        RateWindow {
            kind: kind.to_string(),
            label: kind.to_string(),
            used_percent: pct,
            resets_at: None,
            window_seconds: None,
            scope_model: None,
        }
    }

    fn ok_parsed() -> ParsedUsage {
        ParsedUsage {
            windows: vec![window("5h", 42.0)],
            credits: None,
        }
    }

    fn claude_row(reg: &UsageRegistry) -> ProviderUsage {
        reg.snapshot()
            .providers
            .into_iter()
            .find(|r| r.provider == "claude")
            .expect("claude row present")
    }

    #[test]
    fn starts_with_dormant_rows_for_every_provider() {
        let reg = UsageRegistry::new();
        let meter = reg.snapshot();
        assert_eq!(meter.providers.len(), PROVIDERS.len());
        assert!(meter
            .providers
            .iter()
            .all(|r| r.status == UsageStatus::NotConnected));
        assert!(meter.updated_at.is_none());
    }

    #[test]
    fn mark_ok_sets_windows_and_stamps_updated_at() {
        let reg = UsageRegistry::new();
        reg.mark_ok("claude", ok_parsed());
        let row = claude_row(&reg);
        assert_eq!(row.status, UsageStatus::Ok);
        assert_eq!(row.windows.len(), 1);
        assert!(!row.stale);
        assert!(row.updated_at.is_some());
        assert!(reg.snapshot().updated_at.is_some());
    }

    #[test]
    fn transient_error_marks_stale_but_keeps_last_good_windows() {
        let reg = UsageRegistry::new();
        reg.mark_ok("claude", ok_parsed());
        reg.apply_error("claude", FetchError::Transient("boom".into()));
        let row = claude_row(&reg);
        assert_eq!(row.status, UsageStatus::Stale);
        assert!(row.stale);
        assert_eq!(
            row.windows.len(),
            1,
            "last-good windows are kept on a transient failure"
        );
    }

    #[test]
    fn unauthorized_clears_windows_and_never_refreshes() {
        let reg = UsageRegistry::new();
        reg.mark_ok("claude", ok_parsed());
        reg.apply_error("claude", FetchError::Unauthorized);
        let row = claude_row(&reg);
        assert_eq!(row.status, UsageStatus::Unauthorized);
        assert!(row.message.as_deref().unwrap().contains("re-sign-in"));
        assert!(
            row.windows.is_empty(),
            "an expired session shows a re-auth hint, not bars"
        );
    }

    #[test]
    fn rate_limited_sets_a_cooldown_and_keeps_last_good() {
        let reg = UsageRegistry::new();
        reg.mark_ok("claude", ok_parsed());
        assert!(!reg.in_cooldown("claude"));
        reg.apply_error(
            "claude",
            FetchError::RateLimited {
                retry_after: Some(Duration::from_secs(300)),
            },
        );
        let row = claude_row(&reg);
        assert_eq!(row.status, UsageStatus::RateLimited);
        assert_eq!(row.windows.len(), 1, "last-good windows survive a 429");
        assert!(reg.in_cooldown("claude"), "the provider is now in cooldown");
        assert!(!reg.in_cooldown("codex"), "cooldown is per-provider");
    }

    #[test]
    fn no_creds_renders_a_dormant_not_connected_row() {
        let reg = UsageRegistry::new();
        reg.mark_ok("codex", ok_parsed());
        reg.apply_error("codex", FetchError::NoCreds);
        let row = reg
            .snapshot()
            .providers
            .into_iter()
            .find(|r| r.provider == "codex")
            .unwrap();
        assert_eq!(row.status, UsageStatus::NotConnected);
        assert!(row.windows.is_empty());
    }

    #[test]
    fn disabled_meter_is_all_disabled_rows() {
        let meter = UsageRegistry::disabled_meter();
        assert!(meter
            .providers
            .iter()
            .all(|r| r.status == UsageStatus::Disabled));
    }

    #[test]
    fn arm_flag_is_claimed_once() {
        let reg = UsageRegistry::new();
        assert!(reg.try_arm(), "first arm claims the flag");
        assert!(!reg.try_arm(), "a second arm is a no-op");
        assert!(reg.is_armed());
    }
}
