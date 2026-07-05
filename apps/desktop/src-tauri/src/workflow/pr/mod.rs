//! Create-PR workflow (PR arc, phase 1 — design doc §3.1).
//!
//! The deterministic publish path beside the local merge: probe capability
//! ([`pr_support`]), draft an editable title/body ([`draft_pr_message`]), then
//! push the task's worktree branch and open a GitHub PR ([`create_pr_task`]).
//! `gh` is the GitHub seam — user-installed, `which`-probed, never bundled (the
//! `claude` / gitleaks precedent); `gh` owns auth, Nightcore stores no tokens.
//! Absent `gh` or no `origin` remote ⇒ the capability is reported off and the UI
//! never shows the button, rather than failing on click.
//!
//! Safety posture:
//! - **Same bar as merge.** A PR is a publish; it requires a worktree-mode task
//!   that is committed AND verified, plus a passing readiness + structure-lock
//!   gauntlet — never a side door around the gates.
//! - **argv hygiene.** Every ref goes through `validate_ref` (and the push call
//!   site adds `--end-of-options`); the PR body travels on **stdin**, never argv
//!   (length + injection). Plain `git push` only — NEVER `--force`.
//! - **Re-runnable.** A failure between push and create is safe: the push is
//!   idempotent and `gh` errors loudly (verbatim to the user) when a PR already
//!   exists for the branch.
//! - **[`open_external`] is https-only** so a stored URL can never launch a
//!   local resource or script through the browser seam.

mod capability;
mod create;
mod draft;
mod open;
mod parse;
mod viewer;

// Facade: preserve the historical `crate::workflow::pr::*` paths after the
// god-file split so external call sites keep resolving unchanged — the
// `#[tauri::command]` registrations in `lib.rs` (`pr_support`/`draft_pr_message`/
// `create_pr_task`/`open_external`/`viewer_login`), the ts-rs imports in
// `contracts::ts_bindings` (`PrSupport`/`PrDraft`), and the `pr_in_flight` PR-lease
// guard the phase-2/3 siblings + merge consult. The `gh` seam moved OUT to
// `crate::git::gh` (git + gh execution now share one home), so consumers import
// it from there, not through this facade. Glob re-exports mirror the
// `coordinator`/`sidecar` facades.
pub(crate) use capability::*;
pub(crate) use create::*;
pub(crate) use draft::*;
pub(crate) use open::*;
pub(crate) use viewer::*;
// `parse` is intra-`pr` only (consumed by `create`); no facade re-export.
