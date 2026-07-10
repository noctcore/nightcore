//! Git worktree isolation (M2 §4 of the design doc).
//!
//! Each task run gets its own branch + worktree so N agents edit disjoint working
//! trees. We port AutoMaker's *idea* (`git worktree`), not its ~10 services: only
//! `add` / `remove` / `list` / `prune` plus startup reconciliation, and (later
//! tiers) commit / merge / merge-preview / diff reporting.
//!
//! **Safety invariants** (the highest-risk port, kept small):
//! - Every worktree lives under `<project>/.nightcore/worktrees/<taskId>` — a flat
//!   dir per task id, already gitignored. We never create or remove anything
//!   outside that base, so the user's main checkout can never be touched.
//! - `remove` refuses any path that is not under the base dir (defence in depth
//!   against a bad task id or a hand-edited registry).
//! - Reconciliation only prunes worktrees under our base whose task id is no longer
//!   live; a worktree outside the base is never considered.
//! - If the base working tree is dirty, the loop refuses to start (we never branch
//!   off uncommitted work) — see [`is_worktree_clean`].
//!
//! **Module map** — this file is the coordinator; the git runner trio + porcelain
//! parsers now live in the shared `crate::git` module (built on the same
//! `platform::git_command` isolation chokepoint) and are re-bound here so the
//! submodules reach them as `super::git` unchanged. The worktree-specific concerns
//! are split into cohesive, separately-auditable submodules:
//! - [`path`] — pure path/branch naming + the `is_under` escape guard (no I/O).
//! - [`lifecycle`] — allocate / remove / reconcile (the security-sensitive dir ops).
//! - [`provision`] — install a worktree's deps from its lockfile so the gauntlet resolves them.
//! - [`commit`] — staging + commit inside a worktree (or the project root).
//! - [`merge`] — merge integration + read-only preview + conflict detection.
//! - [`status`] — the main-tree clean check + per-worktree status monitoring.
//! - [`branch`] — base-branch resolution, deletion, and the picker's branch list.
//! - [`diff`] — `--numstat` parsing + the worktree-vs-base changed-file list.
//!
//! The path/branch computation is pure and unit-tested; the git side is exercised
//! by tests (in `tests.rs`) that build a real temp repo when `git` is available.

mod branch;
mod commit;
mod diff;
mod index;
mod lifecycle;
mod merge;
mod path;
mod provision;
mod status;

#[cfg(test)]
mod tests;

// ─── Public API (facade) ───────────────────────────────────────────────────────
// Re-exported so every prior `crate::worktree::X` call site resolves unchanged.

pub use branch::{
    base_branch, current_branch, delete_branch_named, fetch_base, is_branch_merged, list_branches,
    merge_ff_only, push_branch, remote_url, try_ahead_of_upstream, BranchInfo, DEFAULT_BASE_BRANCH,
};
pub use commit::{commit, commit_staged, has_staged_changes, stage_all, staged_diff};
pub use diff::{base_diff, worktree_diff, WorktreeDiff};
pub use lifecycle::{allocate, allocate_branch, reconcile, remove};
pub use merge::{merge_branch, merge_preview, MergeOutcome, MergePreview};
pub use path::{branch_name, is_under, worktree_path, worktrees_base};
pub use provision::provision_deps;
pub use status::{is_worktree_clean, list_worktree_statuses, WorktreeStatus};

// Facade names below are consumed only by cfg(test) code today (the module tests
// and the `contracts::ts_bindings` exporter reach them as `crate::worktree::X`),
// so the non-test build sees these re-exports as unused.
#[allow(unused_imports)]
pub use commit::commit_in;
#[allow(unused_imports)]
pub use diff::{DiffFileStat, DiffStatus, WorktreeDiffFile};
#[allow(unused_imports)]
pub use lifecycle::list_worktree_task_ids;
#[allow(unused_imports)]
pub use merge::MergePreviewStatus;
#[allow(unused_imports)]
pub use status::worktree_status;

// ─── Shared git plumbing ───────────────────────────────────────────────────────
// The git runner trio now lives in the shared `crate::git::run` module (built on
// the same `platform::git_command` isolation chokepoint). Re-bound here (private)
// so the submodules that reach them as `super::git` / `super::git_with_deadline` /
// `super::git_status_success` resolve unchanged, while every OTHER module in the
// crate gets the same runners through `crate::git::run`. (`git_status_success` and
// `merge::detect_merge_conflicts` are the two exit-status/exit-code specializations
// that read `crate::platform::git_command` directly for their custom handling.)
use crate::git::run::{git, git_status_success, git_with_deadline};

// `refresh_index` (the git stat-cache refresh) now lives in `index.rs`. Re-bound
// here (private) so the submodules that reach it as `super::refresh_index` resolve
// unchanged (issue #17 phase D — keeps this module a manifest).
use index::refresh_index;

// The `rev-list --left-right --count` parser now lives in the shared
// `crate::git::parse` module. Re-bound here (private) so the submodules that
// reach it as `super::parse_left_right_count` resolve unchanged.
use crate::git::parse::parse_left_right_count;
