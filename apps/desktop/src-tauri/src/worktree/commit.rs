//! Staging + commit inside a task's worktree (or the project root for main-mode).
//!
//! Confined to the target dir — never spanning worktrees. Covers both the one-shot
//! [`commit`] / [`commit_in`] and the split stage→message→commit flow the commit
//! button uses ([`stage_all`] → [`staged_diff`] → [`commit_staged`]).

use std::path::Path;

use super::path::worktree_path;
use super::{git, git_status_success};

/// Stage everything in a task's worktree and commit it with `message`. Confined to
/// the task's worktree (never the project's main checkout). Returns:
///   - `Ok(true)`  — a commit was created.
///   - `Ok(false)` — nothing to commit (clean tree); the caller surfaces that.
///   - `Err`       — the worktree is missing or git failed.
pub fn commit(project_path: &Path, task_id: &str, message: &str) -> Result<bool, String> {
    let dir = worktree_path(project_path, task_id);
    if !dir.exists() {
        return Err(format!(
            "no worktree for task {task_id} — run it before committing"
        ));
    }
    commit_in(&dir, message)
}

/// Stage everything in `dir` and commit it with `message`. The dir-level primitive
/// behind [`commit`]; also used for `main`-mode tasks (M4.6 §A), which commit in
/// the project root rather than a per-task worktree. Returns `Ok(true)` when a
/// commit was created, `Ok(false)` when the tree was clean (nothing to commit).
pub fn commit_in(dir: &Path, message: &str) -> Result<bool, String> {
    git(dir, &["add", "-A"])?;
    // `diff --cached --quiet` exits non-zero when there is something staged.
    let nothing_staged = git_status_success(dir, &["diff", "--cached", "--quiet"]);
    if nothing_staged {
        return Ok(false); // nothing to commit
    }
    git(dir, &["commit", "-m", message])?;
    Ok(true)
}

/// Stage everything in `dir` (`git add -A`). The first half of the
/// stage→message→commit flow used by the commit button (M-commit): staging is split
/// from committing so the message generator can read the staged diff between them.
pub fn stage_all(dir: &Path) -> Result<(), String> {
    git(dir, &["add", "-A"]).map(|_| ())
}

/// Whether `dir` has staged changes to commit (`git diff --cached --quiet` exits
/// non-zero when something is staged). Call after [`stage_all`] to surface a clean
/// tree as "nothing to commit" before spending a message-generation pass.
pub fn has_staged_changes(dir: &Path) -> bool {
    !git_status_success(dir, &["diff", "--cached", "--quiet"])
}

/// The staged diff text in `dir` (`git diff --cached`). Fed (capped) to the commit-
/// message generator as the primary signal for the Conventional Commits subject.
pub fn staged_diff(dir: &Path) -> Result<String, String> {
    git(dir, &["diff", "--cached"])
}

/// Commit already-staged changes in `dir` with `message`. The commit half of the
/// split flow — assumes [`stage_all`] already ran (and [`has_staged_changes`]
/// returned true), so it never re-stages and never reports "nothing to commit".
pub fn commit_staged(dir: &Path, message: &str) -> Result<(), String> {
    git(dir, &["commit", "-m", message]).map(|_| ())
}
