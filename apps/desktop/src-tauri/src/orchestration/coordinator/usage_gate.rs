//! Usage-aware auto-mode throttle (spec 2026-07-11): a **pre-launch** gate on the
//! coordinator tick that stops the autonomous loop from picking up NEW runs while
//! the run provider's rate-limit meter is hot, and auto-releases when it cools.
//!
//! It is a sibling of the circuit breaker's tick gate — but **non-latching**: the
//! breaker latches `paused` until `resume_auto_loop`; this gate is a LIVE per-tick
//! read of the shipped [`UsageRegistry`] snapshot, so the very next tick after the
//! window drops back under threshold proceeds and launches again (no resume
//! command, decision 3). It NEVER interrupts an in-flight run, NEVER touches
//! concurrency, and NEVER blocks a manual `run_task` (decision 1 — the gate lives
//! only in `tick`, not the shared `submit_run` chokepoint).
//!
//! **Fail-open at every branch** (decision 4): the usage endpoints are
//! reverse-engineered and unversioned, so any uncertainty — meter disabled,
//! snapshot stale/absent, provider row not `Ok` — resolves to "do not gate". An
//! automation halt caused by a flaky telemetry read is a worse failure than an
//! over-run window.
//!
//! The provider-scoped decision itself lives in [`crate::usage`] (which owns
//! provider-id knowledge); this module is the provider-AGNOSTIC coordinator glue:
//! the settings/freshness gates, the one-shot latch, and the OS notification.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::settings::SettingsStore;
use crate::usage::{hot_window, provider_display, UsageRegistry};
// The pause reason is authored in `usage/throttle.rs`; re-export it so the
// coordinator's public surface (`state.rs`, the tick) reads it unqualified.
pub(crate) use crate::usage::UsagePause;

/// How old the usage snapshot may be and still be trusted for gating. Generous —
/// 2× the meter's 600s poll interval — so a briefly-late poll doesn't fail-open
/// prematurely, while a truly stalled poller (or a never-polled cold start) reads
/// as stale and the gate stands down (decision 4).
const USAGE_TRUST_MAX_AGE: Duration = Duration::from_secs(1200);

/// A one-shot latch so the banner-signal + OS notification fire exactly once on the
/// false→true transition, not every 750ms tick (§3.5). Mirrors the breaker's
/// "returns whether THIS failure caused the trip" contract.
#[derive(Default)]
pub(crate) struct UsagePauseLatch(AtomicBool);

impl UsagePauseLatch {
    /// Mark paused; returns `true` on the false→true transition (fire the one-shot).
    pub(crate) fn enter(&self) -> bool {
        !self.0.swap(true, Ordering::SeqCst)
    }

    /// Mark cool; returns `true` if it WAS paused (so the caller re-emits "running").
    pub(crate) fn leave(&self) -> bool {
        self.0.swap(false, Ordering::SeqCst)
    }

    /// Silently end any episode (a manual `stop_auto_loop` / `resume_auto_loop`), so
    /// a later re-heat notifies again as a fresh episode.
    pub(crate) fn reset(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// `Some(reason)` ⇒ the auto-loop should NOT pick up new runs this tick; `None` ⇒
/// proceed. Fail-open: any uncertainty (meter off, snapshot stale/absent, provider
/// row not `Ok`, no window over threshold) returns `None`.
///
/// A live read over managed state — re-evaluated every tick, so it auto-releases the
/// moment the window cools (it does NOT latch; the breaker does).
pub(crate) fn usage_throttle_reason(app: &AppHandle) -> Option<UsagePause> {
    // (a) opt-in gate — the meter must be ON (decision 4). Threshold read here too.
    let (enabled, threshold) = app
        .state::<SettingsStore>()
        .with_settings(|s| (s.usage_meter_enabled, s.auto_pause_usage_threshold));
    if !enabled {
        return None;
    }

    let reg = app.state::<UsageRegistry>();
    // (b) freshness gate (decision 4): never gate on a snapshot we can't trust —
    // including a never-polled cold start, where `stale_enough` returns true.
    if reg.stale_enough(USAGE_TRUST_MAX_AGE) {
        return None;
    }

    // (c–e) the provider-scoped decision lives in `usage/` (which may name a provider
    // id; this module may not — issue #18). It fails open on a missing/degraded row.
    hot_window(threshold, &reg.snapshot())
}

/// Fire ONE native OS notification at the pause transition (§3.6). Clones the
/// shipped `notify_task_complete` idiom — the plugin is already wired
/// (`tauri-plugin-notification`, `notification:default` capability), so this is zero
/// new deps. Best-effort: a failed notification logs at `debug`, never surfaces. The
/// body carries only OUR OWN trusted text — never a token or raw endpoint body.
pub(crate) fn notify_usage_pause(app: &AppHandle, pause: &UsagePause) {
    use tauri_plugin_notification::NotificationExt;
    let title = "Auto Mode paused";
    let body = format!(
        "{} {} at {:.0}%",
        provider_display(&pause.provider),
        pause.window_label,
        pause.used_percent
    );
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::debug!(target: "nightcore", error = %e, "usage-pause notification failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latch_fires_once_per_episode_and_again_after_a_reheat() {
        // The one-shot latch (§3.5): `enter` is true only on the false→true edge, so
        // the notification fires once across N hot ticks; `leave` is true on the
        // true→false edge; a cool→hot re-heat is a fresh episode that fires again.
        let latch = UsagePauseLatch::default();
        assert!(latch.enter(), "first hot tick fires the one-shot");
        assert!(!latch.enter(), "subsequent hot ticks are silent");
        assert!(!latch.enter());
        assert!(latch.leave(), "the cooling tick reports the transition");
        assert!(!latch.leave(), "further cool ticks are silent");
        assert!(latch.enter(), "a re-heat is a new episode — fires again");
        // A manual stop/resume ends the episode silently, so the NEXT heat re-notifies.
        latch.reset();
        assert!(
            latch.enter(),
            "after reset, the next heat is a fresh episode"
        );
    }
}
