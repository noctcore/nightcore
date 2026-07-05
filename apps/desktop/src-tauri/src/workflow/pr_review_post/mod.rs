//! PR Review — the network-facing `gh` seams (design §6, phase 4).
//!
//! Two `gh` operations sit on the Rust side so the read-only review sessions stay
//! network-free:
//! - [`diff::fetch_pr_diff`] — resolve a PR's `gh pr diff <n>` output + changed-file
//!   set, bounded and CAPPED, so `start_pr_review` (the sidecar bridge) can pass the
//!   diff inline on the start command. Called on the blocking pool (it talks to GitHub).
//! - [`post::post_review_to_github`] — the human-gated terminal action: POST one atomic
//!   GitHub review (`{event, body, comments[]}`) built with serde_json (never string
//!   formatting) via `gh api …/reviews --input -`, body on STDIN.
//!
//! Safety posture (the PR-arc rules, unchanged): every `gh` child bounded by a
//! deadline via [`crate::git::gh::run_gh_checked`]; `gh` is the seam and stores no
//! tokens; `pr_number` is a `u64` (decimal, injection-safe); the review body + comment
//! text is Nightcore-authored (our own findings) — trusted — so raw foreign diff text is
//! never echoed back into a comment. `{owner}`/`{repo}` are `gh` placeholders resolved
//! from the run cwd, never a raw remote URL across IPC.
//!
//! Split by concern: [`diff`] is the read-side diff fetch, [`post`] is the
//! write-side review post. The facade preserves the historical
//! `crate::workflow::pr_review_post::{fetch_pr_diff, post_review_to_github,
//! InlineComment, PR_DIFF_CAP}` paths.

use std::time::Duration;

mod diff;
mod post;

#[cfg(test)]
mod tests;

pub(crate) use diff::*;
pub(crate) use post::*;

/// Wall-clock bound on every network-facing PR-review `gh` spawn (diff fetch + post).
/// Same rationale as the create/status bounds: generous but finite — a black-holed
/// GitHub must error out, not pin the blocking thread.
pub(super) const GH_TIMEOUT: Duration = Duration::from_secs(120);
