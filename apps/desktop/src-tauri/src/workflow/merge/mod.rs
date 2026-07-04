//! Commit / merge of verified tasks (M3 §D).
//!
//! Git ops confined to a task's worktree (`commit`) or run as a plain `git merge`
//! into the project base (`merge`, never `--force`). On a clean merge we honor the
//! `cleanupWorktrees` setting; on a conflict the merge is aborted and the task is
//! marked `conflict` for the UI — never forced. Every transition emits `nc:task`.
//!
//! Split by concern (mirrors the `pr/` arc): [`lease`] is the concurrency
//! substrate (per-task single-flight sets, `TaskLease`, the root-mutation lease)
//! shared with the PR arc; [`commit`] is the `commit_task` path plus the
//! [`require_project`] helper; [`integrate`] is the `merge_task` path; and
//! [`review`] resolves verification approval (`accept_review`/`reject_review`/
//! `rerun_verification`). The facade re-exports preserve the historical
//! `crate::workflow::merge::*` (and `crate::merge::*`) paths so external call
//! sites — the `lib.rs` command registrations, the PR siblings' lease/
//! `require_project` imports, and `commit_task_blocking` — resolve unchanged.

mod commit;
mod integrate;
mod lease;
mod review;

#[cfg(test)]
mod tests;

pub(crate) use commit::*;
pub(crate) use integrate::*;
pub(crate) use lease::*;
pub(crate) use review::*;
