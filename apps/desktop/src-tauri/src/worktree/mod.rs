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
//! **Module map** — this file is the coordinator that owns the single [`git`]
//! spawner (the isolation chokepoint) plus the shared output parsers; every git
//! call in every submodule routes through it. The concerns are split into cohesive,
//! separately-auditable submodules:
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

use std::path::Path;

mod branch;
mod commit;
mod diff;
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
    base_branch, current_branch, delete_branch_named, fetch_base, list_branches, merge_ff_only,
    push_branch, remote_url, try_ahead_of_upstream, BranchInfo, DEFAULT_BASE_BRANCH,
};
pub use commit::{commit, commit_staged, has_staged_changes, stage_all, staged_diff};
pub use diff::{base_diff, worktree_diff, WorktreeDiff};
pub use lifecycle::{allocate, allocate_branch, reconcile, remove};
pub use merge::{merge_branch, merge_preview, MergeOutcome, MergePreview};
pub use path::{branch_name, validate_ref, worktree_path};
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

// ─── Shared git plumbing (the isolation chokepoint) ────────────────────────────
// Private to the `worktree` module tree: Rust lets descendant submodules call these
// while keeping the process-spawning surface off the crate-wide API. `git` is the
// sole spawner every submodule routes through (`git_status_success` and
// `merge::detect_merge_conflicts` are the two exit-status/exit-code specializations
// that read `crate::platform::git_command` directly for their custom handling).

/// Run a git subcommand in `repo`, returning trimmed stdout on success or the
/// trimmed stderr as the error.
fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::platform::git_command(repo)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git (is `git` on PATH?): {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Like [`git`], but bounded by a wall-clock `deadline` — for subcommands that
/// talk to the NETWORK (`push`, `fetch`), where a black-holed origin would
/// otherwise pin the calling blocking thread (and any task lease it holds)
/// forever. Same chokepoint (`crate::platform::git_command`, so the git-env
/// isolation is preserved), but spawned with piped output drained on threads and
/// reaped via [`crate::proc::wait_with_deadline`]; on overrun the child is
/// killed and `timeout_msg` is returned as the error.
fn git_with_deadline(
    repo: &Path,
    args: &[&str],
    deadline: std::time::Duration,
    timeout_msg: &str,
) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;

    let mut child = crate::platform::git_command(repo)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run git (is `git` on PATH?): {e}"))?;

    // Drain both pipes on threads so neither can fill and block the child
    // (the claude_oneshot discipline); join after the bounded wait.
    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let mut buf = String::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_string(&mut buf);
            }
            buf
        })
    }
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let status = match crate::proc::wait_with_deadline(&mut child, deadline) {
        Ok(Some(status)) => status,
        Ok(None) => return Err(timeout_msg.to_string()),
        Err(e) => return Err(format!("git did not finish: {e}")),
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    if status.success() {
        Ok(stdout.trim().to_string())
    } else {
        Err(stderr.trim().to_string())
    }
}

/// Run a git subcommand purely for its exit status (no output capture). Returns
/// true on success. Used for predicate-style git calls (`diff --quiet`, `merge`).
fn git_status_success(repo: &Path, args: &[&str]) -> bool {
    crate::platform::git_command(repo)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Best-effort `git update-index --refresh` in `dir` to clear git's stale stat
/// cache. Without it, a worktree that was only `stat`-touched (a build that wrote
/// then restored a file's mtime) can report a false-positive "uncommitted changes"
/// in `git status`. Errors are deliberately swallowed — it is a pure optimization
/// and must never fail a higher-level read (Aperant `refreshGitIndex`).
fn refresh_index(dir: &Path) {
    let _ = git_status_success(dir, &["update-index", "--refresh"]);
}

// The `rev-list --left-right --count` parser now lives in the shared
// `crate::git::parse` module. Re-bound here (private) so the submodules that
// reach it as `super::parse_left_right_count` resolve unchanged.
use crate::git::parse::parse_left_right_count;
