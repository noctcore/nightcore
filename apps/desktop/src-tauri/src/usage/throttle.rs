//! The usage-aware auto-mode throttle's provider-scoped decision (spec 2026-07-11).
//!
//! Lives in `usage/` — NOT `orchestration/` — because it needs provider-id knowledge
//! (which meter row the auto-loop's runs consume), and the arch invariant (issue #18)
//! forbids `orchestration/` from naming a provider id. The coordinator's tick gate
//! (`orchestration/coordinator/usage_gate.rs`) calls [`hot_window`] with the snapshot
//! it already reads, staying provider-agnostic itself.
//!
//! Every branch fails OPEN (returns `None` ⇒ do not gate): the usage endpoints are
//! reverse-engineered and unversioned, so a flaky telemetry read must never halt
//! automation (decision 4).

use crate::provider::CLAUDE_PROVIDER_ID;
use crate::usage::contract::{UsageMeter, UsageStatus};

/// The provider the auto-loop's runs consume — pinned to Claude in v1 (decision 2).
/// Widening to "the provider the runs actually use" (Codex) is a one-line change here
/// when Codex runs ship. Sourced from the factory's id authority (a const, never a
/// stray literal), so it can't drift from the meter's provider-name vocabulary.
const RUN_PROVIDER_ID: &str = CLAUDE_PROVIDER_ID;

/// The reason the auto-loop is usage-paused: which provider window crossed the
/// threshold, its human label, its utilization, and its ISO-8601 reset instant.
/// Feeds the one-shot OS notification (§3.6) and the observability log; the board
/// banner reads the window specifics from the `nc:usage` snapshot it already holds.
#[derive(Debug, Clone)]
pub(crate) struct UsagePause {
    /// The provider whose window is hot (`"claude"` in v1).
    pub provider: String,
    /// The human window label (`"Session (5h)"`, `"Weekly"`, `"Opus weekly"`, …).
    pub window_label: String,
    /// Utilization, normalized `0..=100` at parse time by the meter.
    pub used_percent: f64,
    /// ISO-8601 reset instant, when the provider gives one (for observability).
    pub resets_at: Option<String>,
}

/// `Some(pause)` ⇒ the run provider has ANY rate-limit window at/above `threshold`
/// (the auto-loop should stop picking up new runs); `None` ⇒ proceed. Pure over an
/// already-fresh snapshot — the caller owns the meter-enabled + freshness gates.
///
/// Fail-open: a missing provider row, a non-`Ok`/stale row, or no window over the
/// threshold all return `None`.
pub(crate) fn hot_window(threshold: u8, meter: &UsageMeter) -> Option<UsagePause> {
    // The provider the runs use — v1: Claude.
    let row = meter
        .providers
        .iter()
        .find(|p| p.provider == RUN_PROVIDER_ID)?;
    // Trust the number ONLY when the row is Ok and not stale. Every other status
    // (Stale, RateLimited, Unauthorized, Unsupported, NotConnected, Disabled) is a
    // "do not trust as current" ⇒ fail-open.
    if row.status != UsageStatus::Ok || row.stale {
        return None;
    }
    // ANY window at/above threshold triggers (decision 2): 5h OR weekly OR
    // model-scoped. Scan ALL windows (never the compact set, which drops model
    // lanes); take the hottest for the banner/notification copy.
    let hot = row
        .windows
        .iter()
        .filter(|w| w.used_percent >= f64::from(threshold))
        .max_by(|a, b| a.used_percent.total_cmp(&b.used_percent))?;
    Some(UsagePause {
        provider: row.provider.clone(),
        window_label: hot.label.clone(),
        used_percent: hot.used_percent,
        resets_at: hot.resets_at.clone(),
    })
}

/// A display name for a provider id (`"claude"` → `"Claude"`) for the pause
/// notification/banner copy. Falls back to the raw id for an unknown provider so the
/// copy never blanks.
pub(crate) fn provider_display(provider: &str) -> &str {
    match provider {
        "claude" => "Claude",
        "codex" => "Codex",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::contract::{ProviderUsage, RateWindow};

    fn window(kind: &str, label: &str, pct: f64) -> RateWindow {
        RateWindow {
            kind: kind.to_string(),
            label: label.to_string(),
            used_percent: pct,
            resets_at: Some("2026-07-11T18:00:00Z".to_string()),
            window_seconds: None,
            scope_model: None,
        }
    }

    /// A claude row with the given status/stale and windows; codex is dormant.
    fn meter_with(status: UsageStatus, stale: bool, windows: Vec<RateWindow>) -> UsageMeter {
        let claude = ProviderUsage {
            provider: "claude".to_string(),
            status,
            windows,
            credits: None,
            updated_at: None,
            stale,
            message: None,
        };
        UsageMeter {
            providers: vec![claude, ProviderUsage::not_connected("codex")],
            updated_at: None,
        }
    }

    fn ok_meter(windows: Vec<RateWindow>) -> UsageMeter {
        meter_with(UsageStatus::Ok, false, windows)
    }

    #[test]
    fn disabled_meter_never_gates() {
        // The meter opt-in-off shape (decision 4, branch-a semantics): the claude row
        // is `Disabled`, so the number is never trusted.
        let meter = crate::usage::UsageRegistry::disabled_meter();
        assert!(hot_window(90, &meter).is_none());
    }

    #[test]
    fn every_non_ok_status_fails_open() {
        // Decision 4 / trap (g): only `Ok` + `!stale` is "current". Every other
        // status is a fail-open, even with a window well over threshold.
        for status in [
            UsageStatus::Stale,
            UsageStatus::RateLimited,
            UsageStatus::Unauthorized,
            UsageStatus::Unsupported,
            UsageStatus::NotConnected,
            UsageStatus::Disabled,
        ] {
            let meter = meter_with(status, false, vec![window("5h", "Session (5h)", 99.0)]);
            assert!(
                hot_window(90, &meter).is_none(),
                "status {status:?} must fail-open"
            );
        }
    }

    #[test]
    fn ok_but_stale_row_fails_open() {
        // A last-good row flagged `stale` is not current — fail-open even at 99%.
        let meter = meter_with(
            UsageStatus::Ok,
            true,
            vec![window("5h", "Session (5h)", 99.0)],
        );
        assert!(hot_window(90, &meter).is_none());
    }

    #[test]
    fn missing_provider_row_fails_open() {
        // No claude row at all (a shape we don't recognize) ⇒ fail-open.
        let meter = UsageMeter {
            providers: vec![ProviderUsage::not_connected("codex")],
            updated_at: None,
        };
        assert!(hot_window(90, &meter).is_none());
    }

    #[test]
    fn all_windows_under_threshold_do_not_gate() {
        let meter = ok_meter(vec![
            window("5h", "Session (5h)", 40.0),
            window("weekly", "Weekly", 89.0),
        ]);
        assert!(hot_window(90, &meter).is_none());
    }

    #[test]
    fn a_hot_5h_window_gates_with_its_specifics() {
        let meter = ok_meter(vec![
            window("5h", "Session (5h)", 93.0),
            window("weekly", "Weekly", 50.0),
        ]);
        let pause = hot_window(90, &meter).expect("5h window over threshold gates");
        assert_eq!(pause.provider, "claude");
        assert_eq!(pause.window_label, "Session (5h)");
        assert_eq!(pause.used_percent, 93.0);
        assert!(pause.resets_at.is_some());
    }

    #[test]
    fn a_model_scoped_window_gates_even_when_5h_and_weekly_are_cool() {
        // Decision 2: ANY window, not just the compact 5h/weekly lanes. A model-scoped
        // (`weekly_opus`) window over threshold must gate on its own.
        let meter = ok_meter(vec![
            window("5h", "Session (5h)", 20.0),
            window("weekly", "Weekly", 55.0),
            window("weekly_opus", "Opus weekly", 96.0),
        ]);
        let pause = hot_window(90, &meter).expect("model-scoped window gates");
        assert_eq!(pause.window_label, "Opus weekly");
        assert_eq!(pause.used_percent, 96.0);
    }

    #[test]
    fn the_hottest_window_wins_for_the_banner_copy() {
        // Two windows over threshold: the hottest is chosen for the copy.
        let meter = ok_meter(vec![
            window("5h", "Session (5h)", 91.0),
            window("weekly", "Weekly", 97.5),
        ]);
        let pause = hot_window(90, &meter).expect("gates");
        assert_eq!(pause.window_label, "Weekly");
        assert_eq!(pause.used_percent, 97.5);
    }

    #[test]
    fn threshold_boundary_is_inclusive() {
        // `used_percent == threshold` is hot (>=).
        let meter = ok_meter(vec![window("5h", "Session (5h)", 90.0)]);
        assert!(
            hot_window(90, &meter).is_some(),
            "a window exactly at the threshold gates (>=)"
        );
    }

    #[test]
    fn the_decision_is_live_not_latching() {
        // Non-latching (trap b): the decision has no memory — hot ⇒ Some, cool ⇒ None,
        // hot again ⇒ Some. This is why the gate auto-resumes without a resume command.
        let hot = ok_meter(vec![window("5h", "Session (5h)", 95.0)]);
        let cool = ok_meter(vec![window("5h", "Session (5h)", 10.0)]);
        assert!(hot_window(90, &hot).is_some(), "hot gates");
        assert!(hot_window(90, &cool).is_none(), "cool releases");
        assert!(
            hot_window(90, &hot).is_some(),
            "re-heat gates again — no latch"
        );
    }

    #[test]
    fn provider_display_names_are_capitalized() {
        assert_eq!(provider_display("claude"), "Claude");
        assert_eq!(provider_display("codex"), "Codex");
        assert_eq!(provider_display("mystery"), "mystery");
    }
}
