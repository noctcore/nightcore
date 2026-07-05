//! PR status tracking + the remote-merge closeout (PR arc, phase 2 — design §4).
//!
//! The commands over the phase-1 seams ([`crate::workflow::pr`]):
//! - [`pr_status`] — read-only `gh pr view` snapshot ([`PrStatus`]) fetched on
//!   demand (mount + manual refresh, NO background polling), plus a LOCAL
//!   unpushed-commits count. No lease — it mutates nothing.
//!   [`pr_status_by_number`] is its workspace-scoped sibling for PRs no board
//!   task tracks: same substrate + posture, but `unpushed_commits` is always
//!   `None` (an arbitrary PR has no local branch mapping).
//! - [`push_pr_updates`] — re-push the task branch (plain push, never
//!   `--force`) so review-round fixes reach the open PR. Human-gated in the UI.
//! - [`finalize_merged_pr`] — close the loop on a PR merged ON GitHub: verify
//!   `state == MERGED` server-side (never trust the caller), then mirror the
//!   local merge's post-merge tail (cleanup + `merged` flag + `nc:task`).
//! - [`pull_base_ff`] — fast-forward-ONLY update of the base branch on the
//!   project root (`git fetch` + `git merge --ff-only`; a non-ff base surfaces
//!   git's error verbatim, never a real merge).
//!
//! Safety posture (the phase-1 rules, unchanged): every ref through
//! `validate_ref` + `--end-of-options` at the call sites; every `git`/`gh`
//! child bounded by `wait_with_deadline`; no raw remote URLs across IPC
//! ([`PrStatus::url`] is the gh-reported PR page URL); the mutating commands
//! take the same per-task leases + cross-action refusals as merge/commit/PR
//! creation, so a finalize can never delete a worktree out from under an
//! in-flight push.
//!
//! Split by command over a shared [`view`] read substrate (the `PrStatus` wire
//! type + tolerant `gh pr view` deserialization + the bounded seam): [`status`],
//! [`push`], [`finalize`], and [`pull`]. The facade preserves the historical
//! `crate::workflow::pr_status::*` paths (the four commands + `PrStatus`).

mod finalize;
mod pull;
mod push;
mod status;
mod view;

#[cfg(test)]
mod tests;

pub(crate) use finalize::*;
pub(crate) use pull::*;
pub(crate) use push::*;
pub(crate) use status::*;
pub(crate) use view::*;
