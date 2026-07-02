//! Read-only status monitoring.
//!
//! [`is_worktree_clean`] gates the loop/merge on the main tree; [`worktree_status`]
//! and [`list_worktree_statuses`] report each live worktree's branch/dirty/ahead
//! state for the board's monitor (read-only and tolerant — one bad worktree can't
//! break the list).

use std::path::{Path, PathBuf};

use super::branch::base_branch;
use super::lifecycle::list_worktree_task_ids;
use super::path::{branch_name, worktree_path};
use super::{git, parse_left_right_count, refresh_index};

/// Whether the project's main working tree is clean (no staged/unstaged changes).
/// The loop refuses to start when this is false so runs never branch off
/// uncommitted work. Untracked files under the gitignored `.nightcore/` don't
/// count (git already ignores them).
pub fn is_worktree_clean(project_path: &Path) -> Result<bool, String> {
    let status = git(project_path, &["status", "--porcelain"])?;
    Ok(status.is_empty())
}

/// A live Nightcore worktree's status for the monitoring command (M4.6 §C). One
/// per `nc/<taskId>` worktree on disk; the web groups these by `branch`.
// Exported to TS as `WorktreeInfo` (the board's name for this read-only monitor
// shape) so the generated binding drops in for the prior hand-mirror unchanged.
// `ts-rs` is a dev-dependency, so the codegen derive + attrs are `cfg(test)`-gated.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    test,
    ts(export, rename = "WorktreeInfo", export_to = "WorktreeInfo.ts")
)]
pub struct WorktreeStatus {
    /// The worktree's branch (`nc/<taskId>`).
    pub branch: String,
    /// The absolute worktree path on disk.
    pub path: String,
    /// The task ids this worktree belongs to. v1 is one-per-task, so this is the
    /// single owning task id (a Vec so a later shared-board model fits without a
    /// contract change).
    pub task_ids: Vec<String>,
    /// Whether the worktree has uncommitted changes (`git status --porcelain` is
    /// non-empty). Tolerant: an unreadable/locked worktree reads as `false`.
    pub dirty: bool,
    /// How many commits the worktree's branch is ahead of `base` (HEAD-only commits
    /// from `git rev-list --left-right --count base...HEAD`). Tolerant: unresolvable
    /// reads as `0`.
    pub ahead_of_base: u32,
    /// How many commits the worktree's branch is BEHIND `base` (base-only commits).
    /// Non-zero alongside `ahead_of_base` means the branch has diverged from base.
    /// Tolerant: unresolvable reads as `0`.
    pub behind_of_base: u32,
    /// The number of changed (uncommitted) entries in the worktree — the line count
    /// of `git status --porcelain`. `0` when clean. Tolerant: unreadable reads as `0`.
    pub changed_files: u32,
}

/// Read the status of one live worktree at `dir` for task `task_id`, diffing its
/// branch against `base`. Read-only; tolerant of a missing/locked worktree (a
/// failed git read degrades to `dirty=false` / `ahead_of_base=0` rather than
/// erroring, so one bad worktree can't break the monitor list).
pub fn worktree_status(dir: &Path, task_id: &str, base: &str) -> WorktreeStatus {
    // Clear git's stale stat cache first so a `stat`-touched-but-unchanged file
    // doesn't read as a false-positive dirty (best-effort; never fails the read).
    refresh_index(dir);
    // Read the worktree's ACTUAL checked-out branch — it may be a picker-chosen name
    // (e.g. `feature/foo`), not `nc/<taskId>`. The web groups tasks by exact
    // `task.branch === worktree.branch`, so reporting the real branch keeps a
    // custom-branch task's worktree tab labelled + grouped correctly. Falls back to
    // the deterministic `nc/<taskId>` when HEAD can't be resolved (detached/locked).
    let branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|b| !b.is_empty() && b != "HEAD")
        .unwrap_or_else(|| branch_name(task_id));
    let porcelain = git(dir, &["status", "--porcelain"]).unwrap_or_default();
    let dirty = !porcelain.is_empty();
    let changed_files = if porcelain.is_empty() {
        0
    } else {
        porcelain.lines().count() as u32
    };
    let range = format!("{base}...HEAD");
    let (behind_of_base, ahead_of_base) = git(
        dir,
        &[
            "rev-list",
            "--left-right",
            "--count",
            "--end-of-options",
            &range,
        ],
    )
    .ok()
    .and_then(|s| parse_left_right_count(&s))
    .unwrap_or((0, 0));
    WorktreeStatus {
        branch,
        path: dir.to_string_lossy().to_string(),
        task_ids: vec![task_id.to_string()],
        dirty,
        ahead_of_base,
        behind_of_base,
        changed_files,
    }
}

/// The status of every live Nightcore worktree for a project (M4.6 §C). Reads each
/// worktree dir under the base and reports its branch/dirty/ahead status, diffing
/// against the project's `base_branch`. Tolerant: a worktree that can't be read is
/// reported with safe defaults rather than dropped or erroring.
pub fn list_worktree_statuses(project_path: &Path) -> Vec<WorktreeStatus> {
    let base = base_branch(project_path);
    let dirs: Vec<(String, PathBuf)> = list_worktree_task_ids(project_path)
        .into_iter()
        .map(|id| (id.clone(), worktree_path(project_path, &id)))
        .filter(|(_, dir)| dir.exists())
        .collect();

    // Perf #5: each worktree status spawns two independent `git` processes; with N
    // worktrees the sequential walk is O(N) round-trips. Read them CONCURRENTLY on
    // scoped threads (one per worktree) and recombine in the original order. A
    // scoped thread borrows `base`/`dirs` without `'static`/clone churn. The git
    // reads are already tolerant (a failed read degrades to safe defaults), so one
    // slow/locked worktree can't stall or break the others.
    let base = base.as_str();
    std::thread::scope(|scope| {
        let handles: Vec<_> = dirs
            .iter()
            .map(|(task_id, dir)| scope.spawn(move || worktree_status(dir, task_id, base)))
            .collect();
        // Recombine in the original order. A panicked worker (unexpected git output,
        // an internal unwrap, allocation failure) must degrade to safe defaults for
        // that one entry rather than abort the whole monitor list — same tolerance
        // the git reads already give. Preserve the entry's identity (branch/path/
        // task ids) so the web's branch grouping still works; only the git-derived
        // fields fall back to their unresolved defaults.
        dirs.iter()
            .zip(handles)
            .map(|((task_id, dir), handle)| {
                handle.join().unwrap_or_else(|_| {
                    tracing::warn!(
                        target: "nightcore::worktree",
                        task_id = %task_id,
                        "worktree status thread panicked; degrading to safe defaults for this entry"
                    );
                    WorktreeStatus {
                        branch: branch_name(task_id),
                        path: dir.to_string_lossy().to_string(),
                        task_ids: vec![task_id.to_string()],
                        dirty: false,
                        ahead_of_base: 0,
                        behind_of_base: 0,
                        changed_files: 0,
                    }
                })
            })
            .collect()
    })
}
