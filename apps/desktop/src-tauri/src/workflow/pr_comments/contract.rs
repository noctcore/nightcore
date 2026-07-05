//! The read-only "Review comments" wire contract surfaced to the UI — serde +
//! `ts-rs` mirrors only. `body` fields are UNTRUSTED external text (fenced before
//! they ever reach a prompt — see [`super::command`]); `author` is a trusted
//! GitHub login kept OUTSIDE any fence.

use serde::Serialize;
// ts-rs is a dev-dependency (the Rust→TS codegen runs under `cargo test` only).
#[cfg(test)]
use ts_rs::TS;

/// One comment in a GitHub review thread or a top-level review. `body` is
/// UNTRUSTED external text (anyone can comment on a public PR) — it is fenced
/// through `untrusted_block` before it ever reaches a prompt. `author` is a
/// GitHub login (trusted metadata, kept OUTSIDE the fence).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrComment.ts"))]
pub struct PrComment {
    pub author: String,
    pub body: String,
}

/// An UNRESOLVED inline review thread on the PR: where it anchors (path/line —
/// both optional; a file-level or outdated thread has no line, a detached
/// thread no path) plus its comments in order (>=1). Resolved threads are
/// filtered OUT server-side and never cross the wire.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrThread.ts"))]
pub struct PrThread {
    pub path: Option<String>,
    pub line: Option<u32>,
    pub is_outdated: bool,
    pub comments: Vec<PrComment>,
}

/// A top-level PR review with a non-empty body (the summary text a reviewer
/// writes alongside APPROVE / REQUEST_CHANGES / COMMENT). `body` is UNTRUSTED.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrReviewSummary.ts"))]
pub struct PrReviewSummary {
    pub author: String,
    /// gh vocabulary passed through raw: APPROVED | CHANGES_REQUESTED |
    /// COMMENTED | DISMISSED | PENDING (no enum fork — the UI degrades on drift).
    pub state: String,
    pub body: String,
}

/// The read-only "Review comments" payload: unresolved inline threads + the
/// non-empty top-level review summaries. Deliberately carries no timestamps
/// (the web stamps receive-time locally, like PrStatus).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrReviewComments.ts"))]
pub struct PrReviewComments {
    pub threads: Vec<PrThread>,
    pub reviews: Vec<PrReviewSummary>,
}

/// How the AI triage pass classified one review thread. OUR vocabulary (not
/// GitHub's), so a closed enum is correct — every model answer is NORMALIZED into
/// one of these at parse time (an unknown/garbage class is folded to
/// [`Actionable`](PrCommentTriageClass::Actionable) — the fail-open floor), so the
/// wire value is always one of the four.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, ts(export, export_to = "PrCommentTriageClass.ts"))]
pub enum PrCommentTriageClass {
    /// A real change is needed — the default, and the fail-open floor.
    Actionable,
    /// The reviewer is mistaken or the concern does not apply.
    FalsePositive,
    /// The code already does what the reviewer asks.
    AlreadyAddressed,
    /// The reviewer is asking something that needs a REPLY, not a code change.
    Question,
}

/// One thread's AI triage verdict, aligned to `PrReviewComments.threads` by
/// `index` (0-based). `note` is the model's short (capped) rationale — advisory
/// UI copy only, never fed back to an agent as instructions. Fail-open by
/// construction: a triage pass that fails end-to-end returns every thread as
/// [`PrCommentTriageClass::Actionable`] with an empty note.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrCommentTriage.ts"))]
pub struct PrCommentTriage {
    pub index: u32,
    pub class: PrCommentTriageClass,
    pub note: String,
}
