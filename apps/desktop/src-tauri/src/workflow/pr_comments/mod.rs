//! PR review-comment surfacing + the address-comments fix run (PR arc, phase 3 —
//! design §5).
//!
//! Two commands over the phase-1/2 seams ([`crate::workflow::pr`] /
//! [`crate::workflow::pr_status`]):
//! - [`list_pr_comments`] — read-only `gh api graphql` snapshot of the UNRESOLVED
//!   inline review threads + the non-empty top-level review summaries
//!   ([`PrReviewComments`]), fetched on demand (mount + manual refresh, NO
//!   background polling). No lease — it mutates nothing.
//! - [`address_pr_comments`] — RE-FETCH the comments server-side (never trust the
//!   caller's text), build a FENCED fix prompt (each UNTRUSTED comment body
//!   through `untrusted_block`, author/path/line as trusted metadata OUTSIDE the
//!   fence), then dispatch a fix-BUILD session over the task's existing worktree
//!   (the `rerun_verification` shape), which flows into the normal verify →
//!   gauntlet path. On verified, the phase-2 "Push updates" button publishes the
//!   fixes.
//!
//! Safety posture (the phase-1/2 rules, unchanged): every `gh` child bounded by a
//! deadline; no raw remote URLs across IPC (the payload carries gh-reported logins
//! and bodies only); inbound GitHub text is UNTRUSTED and never reaches a prompt
//! except through the `untrusted_block` fence. Resolved threads are filtered OUT
//! server-side and never cross the wire.
//!
//! Split by concern: [`contract`] holds the serde/ts-rs wire types, [`fetch`] the
//! `gh api graphql` seam + its tolerant deserialization/classification, [`triage`]
//! the fail-open AI classification of the fetched threads (the `claude -p`
//! one-shot), and [`command`] the three `#[tauri::command]`s + their pure guards
//! and fix-prompt builder. The facade preserves the historical
//! `crate::workflow::pr_comments::*` paths (the commands + the wire types).

mod command;
mod contract;
mod fetch;
mod triage;

#[cfg(test)]
mod tests;

pub(crate) use command::*;
pub(crate) use contract::*;
