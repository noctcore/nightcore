//! The `TrustReport` wire contract — the per-task governance receipt
//! (wayfinder #91). Rust-authored (aggregated from Rust stores), so it follows
//! the `GauntletResult` codegen discipline: `#[derive(Serialize, Deserialize)]` +
//! a `cfg(test)`-gated `TS` derive that `cargo test` exports into
//! `apps/web/src/lib/generated/`. It is REGISTERED in `bindings/export.rs` next to
//! `GauntletResult`/`StructureLockResult`; never hand-edit the generated files.
//!
//! `Deserialize` is derived (unlike `GauntletResult`) so the additive `quarantine`
//! seam round-trips through serde — a report serialized without the key
//! deserializes with `quarantine == []`, proving the seam takes a future writer
//! with no shape migration.
//!
//! The report is a TRANSIENT value minted per request (`aggregate::build_report`)
//! and returned over IPC — it is NEVER persisted to `.nightcore/` (locked
//! decision 4). Zero new persistence, zero new writers.

use serde::{Deserialize, Serialize};
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

use crate::store::types::StructureLockResult;
use crate::task::{RunMode, TaskStatus};

/// One per-task governance receipt: what the deterministic gauntlet + reviewer
/// verdicted, what the guardrails held/denied, and a flight-recorder summary of
/// the run. Computed on demand from the persisted `Task`, the flight-recorder
/// ledger, and the transcript — never cached.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "TrustReport.ts"))]
pub struct TrustReport {
    pub task_id: String,
    /// The task title, sanitized to one printable line (untrusted for a
    /// scan-minted task) before it becomes a heading.
    pub title: String,
    pub status: TaskStatus,
    pub run_mode: RunMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub base_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub pr_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub pr_number: Option<u64>,
    /// ISO-8601 UTC mint time — a verifiable timestamp for the demo, anchoring the
    /// receipt's chronology beside the per-event ledger timestamps.
    pub generated_at: String,
    pub gauntlet: GauntletTrust,
    pub guardrails: GuardrailTrust,
    pub flight: FlightSummary,
    /// Injection-quarantine events. v1: ALWAYS empty — the additive seam. A future
    /// writer fills it with NO shape migration (`#[serde(default)]` + the ts-rs
    /// array default `[]`).
    #[serde(default)]
    pub quarantine: Vec<QuarantineEvent>,
}

/// The merge-time gauntlet + reviewer truth, read VERBATIM off the persisted
/// `Task` — never re-run (locked decision 7, §3.3).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "GauntletTrust.ts"))]
pub struct GauntletTrust {
    /// `Task.verified` — true only after an independent reviewer returned PASS.
    pub verified: bool,
    /// The extracted `VERDICT: …` line from `Task.review`, if present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub verdict: Option<String>,
    /// `Task.review` — the reviewer's full verdict text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub review: Option<String>,
    /// `Task.fix_attempts` — bounded auto-fix rounds the verification gate spent.
    pub fix_attempts: u32,
    /// `Task.structure_lock_result` — the deterministic battery (structure-lock +
    /// anti-gaming + contract-budget + ratchet + verify-command), reused verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub structure_lock: Option<StructureLockResult>,
}

/// Guardrail history derived from the per-task flight-recorder ledger (§3.4):
/// durable deny/ask/allow tiers + policy holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "GuardrailTrust.ts"))]
pub struct GuardrailTrust {
    /// Total tool-call decisions the PreToolUse gate recorded across the task.
    pub tools_evaluated: u32,
    pub allowed: u32,
    pub asked: u32,
    pub denied: u32,
    /// Every `deny` decision (tool, rule, digest, ts).
    pub blocked: Vec<GuardrailEvent>,
    /// Every `ask` decision (escalated to interactive approval).
    pub asked_events: Vec<GuardrailEvent>,
    /// The blocked-by-policy message when protected-path denials exist (durable,
    /// derived from the ledger).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub policy_hold: Option<String>,
    /// A diff-budget/policy park message IFF the task currently carries it —
    /// best-effort and TRANSIENT (a later run overwrites `Task.error`), labeled as
    /// such in the render (§3.4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub scope_park: Option<String>,
}

/// One guardrail decision surfaced on the receipt (a `deny` or `ask`). Fields are
/// lenient (mirroring the ledger reader): a record can omit any of them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "GuardrailEvent.ts"))]
pub struct GuardrailEvent {
    /// The tool the gate evaluated (`Bash`/`Write`/…), or `unknown` if unrecorded.
    pub tool: String,
    /// The matched rule id on deny (e.g. `harness-protected-path`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub rule_id: Option<String>,
    /// The input digest (Bash command line / target path) — UNTRUSTED; the render
    /// inline-code-fences + sanitizes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub digest: Option<String>,
    /// The event's ISO-8601 timestamp, when the ledger record carried one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub ts: Option<String>,
    /// `deny` | `ask` (the tier this event belongs to).
    pub decision: String,
}

/// The flight-recorder summary: what the run touched + what it cost.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "FlightSummary.ts"))]
pub struct FlightSummary {
    /// Count of `session-start` markers in the ledger — the authoritative session
    /// tally across build → reviewer → fix.
    pub session_count: u32,
    /// Deduped Write/Edit/MultiEdit/NotebookEdit path digests (capped).
    pub files_touched: Vec<String>,
    /// The pre-cap total distinct files touched.
    pub files_touched_count: u32,
    /// Bash command digests (capped).
    pub commands: Vec<String>,
    /// The pre-cap total commands run.
    pub commands_count: u32,
    /// `Task.cost_usd` — authoritative for the LAST run only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub cost_usd_last_run: Option<f64>,
    /// Transcript-summed cost across all retained sessions — the labeled
    /// approximate total (excludes skipped fix-session spend, §6).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub cost_usd_total: Option<f64>,
    /// Transcript-summed token usage, same approximation caveat as `cost_usd_total`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub tokens: Option<TokenTotals>,
}

/// Token usage totalled across a task's retained sessions.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "TokenTotals.ts"))]
pub struct TokenTotals {
    pub input: u64,
    pub output: u64,
    pub reasoning_output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

/// An injection-quarantine event. v1 PLACEHOLDER — never populated (the report's
/// `quarantine` list is always empty in v1); the shape exists only so a future
/// quarantine writer joins with no migration. Fields are the minimal, all-optional
/// seam (final field set lands with the quarantine feature).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "QuarantineEvent.ts"))]
pub struct QuarantineEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub ts: Option<String>,
}
