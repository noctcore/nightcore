//! The `ProjectTrustSummary` wire contract (issue #399) — the repo-scoped half of
//! the trust story.
//!
//! Rust-authored (aggregated from Rust stores), so it follows the `TrustReport`
//! codegen discipline: `#[derive(Serialize, Deserialize)]` + a `cfg(test)`-gated
//! `TS` derive that `cargo test` exports into `apps/web/src/lib/generated/`, and it
//! is REGISTERED in `bindings/export.rs`. Never hand-edit the generated files.
//!
//! COMPUTED, NEVER STORED (§ the issue's second bullet). The summary is minted per
//! request from the task store, the flight-recorder ledgers and the governance
//! journal, and returned over IPC. Caching it into a file would create a second
//! source of truth that could drift from the journal it summarizes — which is the
//! exact failure the journal exists to prevent. Nothing in this module or its
//! aggregator writes.

use serde::{Deserialize, Serialize};
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

use crate::store::governance::GovernanceEvent;

/// The whole repo-scoped governance posture: what the gates verdicted across every
/// task, what the rails stopped, what it cost, and the human decisions behind it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "ProjectTrustSummary.ts"))]
pub struct ProjectTrustSummary {
    /// ISO-8601 UTC mint time — the summary is computed on demand, so this is when
    /// the numbers were true, not when anything was saved.
    pub generated_at: String,
    pub merges: MergeTotals,
    pub gauntlet: GauntletTotals,
    pub guardrails: GuardrailTotals,
    pub spend: SpendTotals,
    pub journal: JournalSummary,
    /// The shields-compatible badge derived from the totals above — the same value
    /// the badge export serializes, so the dashboard and the published badge can
    /// never disagree.
    pub badge: TrustBadge,
}

/// Task outcomes: how much of what this repo shipped went through the gates.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "MergeTotals.ts"))]
pub struct MergeTotals {
    /// Every task the store holds (the denominator that keeps the rest honest).
    pub tasks: u32,
    pub merged: u32,
    /// `Task.verified` — an independent reviewer returned PASS.
    pub verified: u32,
    /// The headline: merged AND verified. A merge without a reviewer PASS is not a
    /// verified merge, however green it looked.
    pub verified_merges: u32,
}

/// The deterministic battery's record across every task that ran it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "GauntletTotals.ts"))]
pub struct GauntletTotals {
    /// Tasks carrying a `structure_lock_result` (the ones the gauntlet actually ran
    /// against) — NOT every task.
    pub runs: u32,
    pub passed: u32,
    /// `passed / runs` in `0.0..=1.0`, or `None` when the gauntlet has never run —
    /// an explicit "no data", never a misleading 0% or 100%.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub pass_rate: Option<f64>,
}

/// What the PreToolUse rails did across every session this project recorded.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "GuardrailTotals.ts"))]
pub struct GuardrailTotals {
    pub tools_evaluated: u32,
    pub allowed: u32,
    pub asked: u32,
    pub denied: u32,
    /// The subset of `denied` attributed to a rule from THIS project's policy
    /// (`harness-*`) rather than a built-in engine rail — the number that tells an
    /// author whether the rules they wrote are load-bearing.
    pub policy_denials: u32,
    /// The rules that fired most, capped. Ordered by count descending.
    pub top_rules: Vec<RuleTally>,
    /// Task ledgers that contributed (the sessions this summary read).
    pub sessions: u32,
}

/// One rule and how often it stopped or escalated a tool call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "RuleTally.ts"))]
pub struct RuleTally {
    pub rule_id: String,
    pub count: u32,
    /// `policy` (a rule from this project's manifest) | `builtin` (an engine rail).
    pub source: String,
}

/// What the autonomy cost.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "SpendTotals.ts"))]
pub struct SpendTotals {
    /// Summed `Task.cost_usd`. APPROXIMATE and labeled as such in the UI:
    /// `cost_usd` is authoritative for a task's LAST run only, so a task rerun
    /// several times contributes only its final run. Deliberately cheap — the exact
    /// figure would mean reading every transcript on every dashboard open.
    pub cost_usd: f64,
    /// How many tasks carried a cost at all (the rest never ran, or predate the
    /// field).
    pub tasks_with_cost: u32,
}

/// The governance journal rolled up: per-kind counts plus a recent tail.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "JournalSummary.ts"))]
pub struct JournalSummary {
    pub events: u32,
    pub quarantines: u32,
    pub policy_saves: u32,
    pub arms: u32,
    pub disarms: u32,
    pub ratchets: u32,
    /// Records whose kind this build does not know (a journal written by a newer
    /// Nightcore) — counted rather than hidden.
    pub other: u32,
    /// Lines that were present but unparseable. Surfaced so a corrupted journal is
    /// VISIBLE instead of silently shrinking the numbers above.
    pub corrupt_lines: u32,
    /// The newest event's timestamp, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub last_event_at: Option<String>,
    /// The most recent records, newest first and capped — the dashboard's feed.
    pub recent: Vec<GovernanceEvent>,
}

/// A [shields.io endpoint](https://shields.io/badges/endpoint-badge) payload: the
/// repo's governance posture in the exact shape `https://img.shields.io/endpoint`
/// consumes, so publishing it is "host this JSON, point the badge at it".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "TrustBadge.ts"))]
pub struct TrustBadge {
    /// Always `1` — the schema version shields requires on an endpoint response.
    pub schema_version: u32,
    pub label: String,
    pub message: String,
    /// A shields colour name (`brightgreen` / `green` / `yellow` / `orange` /
    /// `red` / `lightgrey`).
    pub color: String,
}
