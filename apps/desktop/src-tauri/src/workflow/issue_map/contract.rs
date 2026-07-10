//! The issue-map Rust→TS boundary types (ts-rs, NOT zod — everything the web
//! renders is Rust-authored, aggregated from the Rust stores and composed for
//! GitHub, so it follows the `TrustReport`/`InsightRun` codegen discipline).
//!
//! `cargo test` regenerates `apps/web/src/lib/generated/*` from these (registered in
//! `bindings/export.rs`). Never hand-edit the generated files.

use serde::{Deserialize, Serialize};
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

/// The transient payload the preview dialog renders (§3.1). Everything DETERMINISTIC
/// (structure/counts/titles/bodies/provenance) is re-derived Rust-side in both the
/// preview and the write command; the only non-deterministic content is the LLM
/// [`Narrative`], threaded back to the write command so the previewed bytes are
/// exactly what posts (§3.8). Not persisted — a fresh value per preview.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "IssueMapPreview.ts"))]
pub struct IssueMapPreview {
    /// `insight` | `scorecard` | `enforce` (the wire string).
    pub scan_kind: String,
    pub run_id: String,
    /// ISO-8601 UTC, minted ONCE at preview and threaded to post (preview == post).
    pub generated_at: String,
    /// Deterministic (e.g. "Nightcore Insight map — 24 findings").
    pub parent_title: String,
    /// The FULL rendered parent markdown (exec summary + groups + counts +
    /// provenance + supersede line) — rendered in the dialog via `<Markdown>`.
    pub parent_body: String,
    /// One per finding, in the deterministic order (title only — bodies are large).
    pub sub_issues: Vec<SubIssuePreview>,
    pub total: u32,
    /// Deterministic grouping/counts for the dialog chips.
    pub groups: Vec<GroupCount>,
    /// The prior `nc:map` for this project+kind, if one is open (supersede link).
    pub supersedes: Option<PriorMap>,
    /// `Some("This will open 63 issues…")` when `total` exceeds the soft warn (~50).
    pub soft_warning: Option<String>,
    /// The LLM narrative, threaded back to the write command so preview == post.
    pub narrative: Narrative,
    /// `false` ⇒ the LLM pass fell open to deterministic text (surface a subtle note).
    pub narrative_ok: bool,
}

/// One sub-issue's preview row — its title + which deterministic group it lands in.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "SubIssuePreview.ts"))]
pub struct SubIssuePreview {
    pub title: String,
    pub group_label: String,
}

/// A deterministic group's label + count, for the dialog chips + the counts table.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "GroupCount.ts"))]
pub struct GroupCount {
    pub label: String,
    pub count: u32,
}

/// A prior `nc:map` parent for this project+kind (the supersede target, §3.10). Also
/// the shape returned as the created parent in [`IssueMapResult`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PriorMap.ts"))]
pub struct PriorMap {
    pub number: u64,
    pub title: String,
    pub url: String,
}

/// One per-group intro line the LLM produced, keyed by the group's label.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "GroupIntro.ts"))]
pub struct GroupIntro {
    pub label: String,
    pub intro: String,
}

/// The (semi-untrusted) LLM narrative: the parent's executive summary + a one-line
/// intro per group. Carried on the preview and handed back UNCHANGED to the write
/// command, which re-sanitizes it (§3.6) before interleaving it at the same
/// deterministic slots, so the posted parent body is byte-identical to the preview.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "IssueMapNarrative.ts"))]
pub struct Narrative {
    pub exec_summary: String,
    pub group_intros: Vec<GroupIntro>,
}

impl Narrative {
    /// The intro for `label`, if the narrative carried one.
    pub(crate) fn intro_for(&self, label: &str) -> Option<&str> {
        self.group_intros
            .iter()
            .find(|g| g.label == label)
            .map(|g| g.intro.as_str())
    }
}

/// The terminal result of an export (§3.2.1). The multi-issue create is NOT a
/// transaction — a mid-run failure STOPS and returns this partial result, never a
/// rollback (nothing is ever deleted). The parent is created first (happy path) so a
/// partial map is always a real, browsable parent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "IssueMapResult.ts"))]
pub struct IssueMapResult {
    /// The parent that landed — surface its link even on a partial run.
    pub parent: PriorMap,
    /// Sub-issues successfully created AND attached.
    pub created: u32,
    /// = N (the number attempted).
    pub attempted: u32,
    /// The finding index that failed (`None` ⇒ full success).
    pub failed_at: Option<u32>,
    pub partial: bool,
    /// The mapped `gh` failure at `failed_at`.
    pub error: Option<String>,
    /// `true` if native sub-issues were unavailable and we fell back to task-list
    /// linkage (§3.2.2).
    pub degraded_linkage: bool,
    /// A best-effort supersede-close warning (a close failure is surfaced, not fatal).
    pub supersede_warning: Option<String>,
}
