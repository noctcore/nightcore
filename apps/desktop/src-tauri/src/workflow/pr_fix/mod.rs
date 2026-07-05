//! The PR fix runner (the PR arc's fix sibling of the PR-review scan): run one
//! agent fix session on a PR's branch — addressing selected
//! [`crate::store::pr_review`] findings (`findings`), the PR's failing CI
//! checks (`ci`), or its merge conflicts against base (`conflicts`) —
//! auto-commit whatever it produced, and expose a HUMAN-GATED push (optionally
//! posting a summary comment on the PR).
//!
//! Deliberately NOT a board task. A pr-fix has no backlog row, no verification
//! gate, and no slot: its lifecycle is `running → awaiting_push → pushed` (or
//! `failed`), tracked by the in-memory [`PrFixRegistry`] and streamed as full
//! [`PrFixState`] snapshots on `nc:pr-fix`. The registry is v1-in-memory: an
//! app restart forgets the entries but never the WORK — the session's edits are
//! auto-committed onto the PR branch in its checkout the moment it completes,
//! so the surviving commit can always be pushed by hand.
//!
//! Flow:
//! 1. [`address_review_findings`] selects findings from a persisted PR-review
//!    run, resolves a checkout — a board task's worktree when one tracks the PR
//!    (leasing `pr_in_flight` under THAT task's id, mutually exclusive with its
//!    task-scoped PR actions), else a managed `git worktree add` of the PR head
//!    branch under `.nightcore/pr-fix/pr-<n>` (fork PRs refused; never
//!    reset/force) — builds a FENCED prompt (every model-derived finding body
//!    through `untrusted_block`), and starts a `kind=build` session whose
//!    correlation id is the FIX id.
//! 2. The `sidecar::reader` intercept routes that id's terminals here instead
//!    of the task store: [`handle_fix_completed`] commits (`worktree::commit_in`)
//!    and parks the fix `awaiting_push`; [`handle_fix_failed`] marks it failed.
//! 3. [`push_pr_fix`] — the human gate — re-leases and plain-pushes the branch
//!    (never `--force`). [`cancel_pr_fix`] interrupts the live session.
//!
//! Safety posture: the PR-arc rules throughout — every ref `validate_ref`-ed +
//! `--end-of-options`-fenced, every `gh`/network-`git` child deadline-bounded,
//! untrusted review text fenced, plain push only, and the push is human-gated.

mod checkout;
mod ci;
mod command;
mod comment;
mod complete;
mod conflicts;
mod prompt;
mod state;

#[cfg(test)]
mod tests;

// Facade: the `#[tauri::command]` glob (so the macro's generated siblings reach
// `workflow::pr_fix::*` for `generate_handler!`), the reader-intercept handlers,
// and the managed registry + wire state.
pub(crate) use command::*;
pub(crate) use complete::{handle_fix_completed, handle_fix_failed};
pub(crate) use state::{refuse_while_fix_pending_push, refuse_while_fix_running, PrFixRegistry};
// Consumed by the cfg(test) ts-rs exporter (`contracts::ts_bindings`) only —
// runtime code reaches the state through the registry.
#[allow(unused_imports)]
pub(crate) use state::PrFixState;
