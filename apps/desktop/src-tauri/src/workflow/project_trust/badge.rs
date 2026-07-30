//! The shields-compatible badge: one deterministic function from the computed
//! totals to a governance posture a repo can publish (issue #399, third bullet).
//!
//! DERIVED, never independent. The badge is a projection of the same
//! [`ProjectTrustSummary`] fields the dashboard renders, so a published badge can
//! never claim something the dashboard contradicts. It is pure — no clock, no
//! filesystem — so the thresholds below are pinned by unit tests rather than by
//! eyeballing a rendered image.

use super::contract::{GauntletTotals, GuardrailTotals, MergeTotals, TrustBadge};

/// The badge label. Fixed, so a repo that publishes it reads the same everywhere.
const LABEL: &str = "governance";

/// Shields colour vocabulary (the subset this posture uses).
const BRIGHTGREEN: &str = "brightgreen";
const GREEN: &str = "green";
const YELLOW: &str = "yellow";
const ORANGE: &str = "orange";
const LIGHTGREY: &str = "lightgrey";

/// Gauntlet pass rate at or above which the posture is unqualified green.
const STRONG_PASS_RATE: f64 = 0.95;
/// …and above which it is still green.
const GOOD_PASS_RATE: f64 = 0.85;
/// …and above which it is a warning rather than a problem.
const WEAK_PASS_RATE: f64 = 0.60;

/// Build the badge from the totals.
///
/// The posture answers ONE question — "would I trust what this repo merged?" — so
/// the colour is driven by the deterministic gate's pass rate, and the message
/// leads with verified merges (the thing a lead actually asks for). A repo with no
/// gauntlet history is `lightgrey` "not measured": claiming green for a project
/// that has never run a gate would be the worst possible badge.
pub(super) fn build_badge(
    merges: &MergeTotals,
    gauntlet: &GauntletTotals,
    guardrails: &GuardrailTotals,
) -> TrustBadge {
    let Some(rate) = gauntlet.pass_rate else {
        return TrustBadge {
            schema_version: 1,
            label: LABEL.to_string(),
            message: "not measured".to_string(),
            color: LIGHTGREY.to_string(),
        };
    };

    let percent = (rate * 100.0).round() as u32;
    let mut message = format!(
        "{} verified merge{} · {percent}% gauntlet",
        merges.verified_merges,
        if merges.verified_merges == 1 { "" } else { "s" }
    );
    if guardrails.denied > 0 {
        message.push_str(&format!(
            " · {} denial{}",
            guardrails.denied,
            if guardrails.denied == 1 { "" } else { "s" }
        ));
    }

    let color = if rate >= STRONG_PASS_RATE && merges.verified_merges > 0 {
        BRIGHTGREEN
    } else if rate >= GOOD_PASS_RATE {
        GREEN
    } else if rate >= WEAK_PASS_RATE {
        YELLOW
    } else {
        ORANGE
    };

    TrustBadge {
        schema_version: 1,
        label: LABEL.to_string(),
        message,
        color: color.to_string(),
    }
}
