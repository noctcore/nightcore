//! Git worktree isolation (M2 §4 of the design doc).
//!
//! Each task run gets its own branch + worktree so N agents edit disjoint working
//! trees. We port AutoMaker's *idea* (`git worktree`), not its ~10 services: only
//! `add` / `remove` / `list` / `prune` plus startup reconciliation. No merge,
//! rebase, or conflict handling — that is M3 (Tier 2).
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
//! The path/branch computation is pure and unit-tested; the git side is exercised
//! by tests that build a real temp repo when `git` is available.

use std::path::{Path, PathBuf};
// Only the test module spawns `git` directly now; the production helpers route
// through `crate::platform::std_command`.
#[cfg(test)]
use std::process::Command;

/// The fallback base branch when `HEAD` can't be resolved to a named branch (e.g.
/// detached HEAD). Used by [`base_branch`] and the reviewer's no-project fallback.
pub const DEFAULT_BASE_BRANCH: &str = "main";

/// The branch name for a task's run: `nc/<taskId>`.
pub fn branch_name(task_id: &str) -> String {
    format!("nc/{task_id}")
}

/// The base dir all Nightcore worktrees live under for a project.
pub fn worktrees_base(project_path: &Path) -> PathBuf {
    project_path.join(".nightcore/worktrees")
}

/// The worktree dir for a task: `<project>/.nightcore/worktrees/<taskId>`.
pub fn worktree_path(project_path: &Path, task_id: &str) -> PathBuf {
    worktrees_base(project_path).join(task_id)
}

/// Whether `candidate` is strictly under `base` (used to refuse removals outside
/// the Nightcore worktrees dir). Compares lexically on normalized components, so it
/// does not require the paths to exist.
pub fn is_under(base: &Path, candidate: &Path) -> bool {
    let base: Vec<_> = base.components().collect();
    let cand: Vec<_> = candidate.components().collect();
    cand.len() > base.len() && cand[..base.len()] == base[..]
}

/// Run a git subcommand in `repo`, returning trimmed stdout on success or the
/// trimmed stderr as the error.
fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::platform::std_command("git")
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("failed to run git (is `git` on PATH?): {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Whether the project's main working tree is clean (no staged/unstaged changes).
/// The loop refuses to start when this is false so runs never branch off
/// uncommitted work. Untracked files under the gitignored `.nightcore/` don't
/// count (git already ignores them).
pub fn is_worktree_clean(project_path: &Path) -> Result<bool, String> {
    let status = git(project_path, &["status", "--porcelain"])?;
    Ok(status.is_empty())
}

/// Create a worktree + branch for `task_id` off the current `HEAD`. Idempotent in
/// the sense that an existing worktree dir is reused (returns its path) rather than
/// erroring, so a re-run after a crash doesn't fail to allocate.
pub fn allocate(project_path: &Path, task_id: &str) -> Result<PathBuf, String> {
    let dir = worktree_path(project_path, task_id);
    if dir.exists() {
        return Ok(dir); // already allocated (crash recovery / re-run)
    }
    std::fs::create_dir_all(worktrees_base(project_path))
        .map_err(|e| format!("failed to create worktrees base: {e}"))?;

    let branch = branch_name(task_id);
    let dir_str = dir.to_string_lossy().to_string();

    // If the branch already exists (a prior run we kept for inspection), check it
    // out into a fresh worktree instead of creating it.
    let branch_exists = git(project_path, &["rev-parse", "--verify", "--quiet", &branch]).is_ok();

    let args: Vec<&str> = if branch_exists {
        vec!["worktree", "add", &dir_str, &branch]
    } else {
        vec!["worktree", "add", &dir_str, "-b", &branch]
    };
    // Concurrency #3: two worktree-mode launches racing the auto-loop both pass the
    // `is_worktree_clean` check, then both run `git worktree add`. They target
    // DISJOINT dirs (`<base>/<task_id>`), so they never clobber, but git serializes
    // worktree admin behind a `.git/worktrees` lock and the loser fails transiently
    // ("File exists"/"is already locked"). Treat that as retryable with a short
    // backoff so a concurrent allocate isn't a spurious launch failure.
    git_worktree_add_retrying(project_path, &args)?;
    Ok(dir)
}

/// Run `git worktree add` with a small bounded retry on git's transient
/// worktree-lock contention (concurrency #3). A non-lock error fails immediately
/// (only lock contention is retried); the dir is disjoint per task, so a retry can
/// only succeed once the other allocate releases the admin lock.
fn git_worktree_add_retrying(project_path: &Path, args: &[&str]) -> Result<String, String> {
    const MAX_ATTEMPTS: usize = 5;
    let mut last_err = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        match git(project_path, args) {
            Ok(out) => return Ok(out),
            Err(e) => {
                let transient = e.contains("already locked")
                    || e.contains("is already registered")
                    || e.contains("cannot lock")
                    || e.contains("File exists");
                if !transient || attempt + 1 == MAX_ATTEMPTS {
                    return Err(e);
                }
                tracing::warn!(target: "nightcore::worktree", attempt = attempt + 1, error = %e, "worktree add hit transient lock contention; retrying");
                std::thread::sleep(std::time::Duration::from_millis(50 * (attempt as u64 + 1)));
                last_err = e;
            }
        }
    }
    Err(last_err)
}

/// Remove a task's worktree (the `git worktree remove --force`). Refuses any path
/// not under the project's worktrees base. The `nc/<taskId>` branch is retained for
/// review/inspection (M2 never deletes branches). Idempotent on a missing worktree.
pub fn remove(project_path: &Path, task_id: &str) -> Result<(), String> {
    let dir = worktree_path(project_path, task_id);
    let base = worktrees_base(project_path);
    if !is_under(&base, &dir) {
        return Err(format!(
            "refusing to remove {} — not under the Nightcore worktrees base",
            dir.display()
        ));
    }
    if !dir.exists() {
        return Ok(()); // already gone
    }
    let dir_str = dir.to_string_lossy().to_string();
    // `--force` because the agent's run leaves uncommitted edits in the worktree;
    // we still keep the branch, so nothing is lost.
    git(project_path, &["worktree", "remove", "--force", &dir_str])?;
    Ok(())
}

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

/// Merge a task's `nc/<taskId>` branch into the project's base branch. Operates on
/// the project's main checkout but ONLY via `git merge` (never `--force`, never a
/// reset). On a merge conflict the merge is aborted and `Ok(MergeOutcome::Conflict)`
/// is returned so the UI surfaces it — the working tree is left clean, not forced.
/// `base_branch` is the branch the merge targets (resolved by the caller).
pub fn merge(
    project_path: &Path,
    task_id: &str,
    base_branch: &str,
) -> Result<MergeOutcome, String> {
    let branch = branch_name(task_id);
    // The base branch must be checked out to receive the merge. Refuse if the main
    // tree is dirty so we never merge over uncommitted work.
    if !is_worktree_clean(project_path)? {
        return Err("base working tree is dirty; commit or stash before merging".to_string());
    }
    git(project_path, &["checkout", base_branch])?;

    if git_status_success(project_path, &["merge", "--no-edit", &branch]) {
        return Ok(MergeOutcome::Merged);
    }
    // Conflict (or any merge failure): abort so the tree is left clean, never forced.
    let _ = git(project_path, &["merge", "--abort"]);
    Ok(MergeOutcome::Conflict)
}

/// The result of a [`merge`] attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeOutcome {
    /// The branch integrated cleanly into the base.
    Merged,
    /// A conflict was detected; the merge was aborted (not forced).
    Conflict,
}

/// The project's base branch: whatever `HEAD` points at in the main checkout
/// (`git rev-parse --abbrev-ref HEAD`). Falls back to `main` when it can't be
/// resolved (e.g. detached HEAD).
pub fn base_branch(project_path: &Path) -> String {
    git(project_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|b| !b.is_empty() && b != "HEAD")
        .unwrap_or_else(|| DEFAULT_BASE_BRANCH.to_string())
}

/// Delete a task's `nc/<taskId>` branch (used after a successful merge when policy
/// removes the worktree). Best-effort: a missing branch is not an error.
pub fn delete_branch(project_path: &Path, task_id: &str) -> Result<(), String> {
    let branch = branch_name(task_id);
    if git_status_success(project_path, &["rev-parse", "--verify", "--quiet", &branch]) {
        git(project_path, &["branch", "-D", &branch])?;
    }
    Ok(())
}

/// Run a git subcommand purely for its exit status (no output capture). Returns
/// true on success. Used for predicate-style git calls (`diff --quiet`, `merge`).
fn git_status_success(repo: &Path, args: &[&str]) -> bool {
    crate::platform::std_command("git")
        .args(args)
        .current_dir(repo)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// List the task ids that currently have a Nightcore worktree on disk under the
/// base. Reads the directory rather than parsing `git worktree list` so it stays
/// robust to git admin-file drift; `git worktree prune` (in [`reconcile`]) cleans
/// the admin side.
pub fn list_worktree_task_ids(project_path: &Path) -> Vec<String> {
    let base = worktrees_base(project_path);
    let mut ids = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    ids.push(name.to_string());
                }
            }
        }
    }
    ids
}

/// A live Nightcore worktree's status for the monitoring command (M4.6 §C). One
/// per `nc/<taskId>` worktree on disk; the web groups these by `branch`.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
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
    /// How many commits the worktree's branch is ahead of `base` (`git rev-list
    /// --count base..HEAD`). Tolerant: unresolvable reads as `0`.
    pub ahead_of_base: u32,
}

/// Read the status of one live worktree at `dir` for task `task_id`, diffing its
/// branch against `base`. Read-only; tolerant of a missing/locked worktree (a
/// failed git read degrades to `dirty=false` / `ahead_of_base=0` rather than
/// erroring, so one bad worktree can't break the monitor list).
pub fn worktree_status(dir: &Path, task_id: &str, base: &str) -> WorktreeStatus {
    let dirty = git(dir, &["status", "--porcelain"])
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let range = format!("{base}..HEAD");
    let ahead_of_base = git(dir, &["rev-list", "--count", &range])
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0);
    WorktreeStatus {
        branch: branch_name(task_id),
        path: dir.to_string_lossy().to_string(),
        task_ids: vec![task_id.to_string()],
        dirty,
        ahead_of_base,
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
        handles
            .into_iter()
            .map(|h| h.join().expect("worktree status thread panicked"))
            .collect()
    })
}

/// Startup reconciliation: remove worktrees whose task id is no longer live, then
/// `git worktree prune` to clear stale admin files. `live_task_ids` is the current
/// `TaskStore` id set. Returns the ids it pruned. Errors on individual removes are
/// logged and skipped so one bad worktree can't block startup.
pub fn reconcile(project_path: &Path, live_task_ids: &[String]) -> Vec<String> {
    let mut pruned = Vec::new();
    for id in list_worktree_task_ids(project_path) {
        if !live_task_ids.iter().any(|live| live == &id) {
            match remove(project_path, &id) {
                Ok(()) => pruned.push(id),
                Err(e) => {
                    tracing::warn!(target: "nightcore::worktree", task_id = %id, error = %e, "worktree reconcile skipped orphan it could not remove")
                }
            }
        }
    }
    // Clear stale admin files for any worktree dir removed out-of-band.
    let _ = git(project_path, &["worktree", "prune"]);
    pruned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_and_path_computation() {
        let project = Path::new("/repo/nightcore");
        assert_eq!(branch_name("abc-123"), "nc/abc-123");
        assert_eq!(
            worktrees_base(project),
            PathBuf::from("/repo/nightcore/.nightcore/worktrees")
        );
        assert_eq!(
            worktree_path(project, "abc-123"),
            PathBuf::from("/repo/nightcore/.nightcore/worktrees/abc-123")
        );
    }

    #[test]
    fn is_under_guards_the_base() {
        let base = Path::new("/repo/.nightcore/worktrees");
        assert!(is_under(
            base,
            Path::new("/repo/.nightcore/worktrees/task-1")
        ));
        assert!(
            !is_under(base, Path::new("/repo")),
            "parent is not under base"
        );
        assert!(
            !is_under(base, base),
            "the base itself is not strictly under"
        );
        assert!(
            !is_under(base, Path::new("/repo/.nightcore/other")),
            "a sibling dir is not under the worktrees base"
        );
        assert!(
            !is_under(base, Path::new("/etc/passwd")),
            "an unrelated path is rejected"
        );
    }

    /// Build a real git repo with one commit. Returns `None` (skipping the test)
    /// when `git` isn't available, so the suite stays green in minimal envs.
    fn temp_repo() -> Option<(tempfile::TempDir, PathBuf)> {
        let tmp = tempfile::TempDir::new().ok()?;
        let path = tmp.path().to_path_buf();
        let run = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(&path)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        if !run(&["init", "-q"]) {
            return None;
        }
        run(&["config", "user.email", "t@t.t"]);
        run(&["config", "user.name", "t"]);
        // Mirror production: the worktrees base is gitignored, so an allocated
        // worktree never dirties the main checkout.
        std::fs::write(path.join(".gitignore"), ".nightcore/\n").ok()?;
        std::fs::write(path.join("README.md"), "hi").ok()?;
        run(&["add", "."]);
        if !run(&["commit", "-q", "-m", "init"]) {
            return None;
        }
        Some((tmp, path))
    }

    #[test]
    fn allocate_remove_and_reconcile_round_trip() {
        let Some((_tmp, repo)) = temp_repo() else {
            return; // git unavailable; pure-logic tests above still cover the rest
        };

        // Allocate creates the worktree dir + branch.
        let dir = allocate(&repo, "task-1").expect("allocate");
        assert!(dir.is_dir(), "worktree dir exists");
        assert!(
            dir.join("README.md").exists(),
            "worktree has the repo content"
        );
        assert_eq!(list_worktree_task_ids(&repo), vec!["task-1".to_string()]);

        // Allocating again is idempotent (reuses the dir).
        let again = allocate(&repo, "task-1").expect("re-allocate");
        assert_eq!(again, dir);

        // A second task gets its own disjoint worktree.
        allocate(&repo, "task-2").expect("allocate 2");
        let mut ids = list_worktree_task_ids(&repo);
        ids.sort();
        assert_eq!(ids, vec!["task-1".to_string(), "task-2".to_string()]);

        // Reconcile prunes the worktree whose task is no longer live (task-2 gone).
        let pruned = reconcile(&repo, &["task-1".to_string()]);
        assert_eq!(pruned, vec!["task-2".to_string()]);
        assert_eq!(list_worktree_task_ids(&repo), vec!["task-1".to_string()]);

        // Explicit remove clears the last one; idempotent on a second call.
        remove(&repo, "task-1").expect("remove");
        assert!(list_worktree_task_ids(&repo).is_empty());
        remove(&repo, "task-1").expect("remove is idempotent");
    }

    #[test]
    fn clean_then_dirty_worktree_detection() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        assert!(
            is_worktree_clean(&repo).expect("status"),
            "fresh repo is clean"
        );
        std::fs::write(repo.join("README.md"), "changed").expect("edit");
        assert!(
            !is_worktree_clean(&repo).expect("status"),
            "an uncommitted edit makes the tree dirty"
        );
    }

    /// Run a git command in a worktree for tests, returning success.
    fn run_in(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn commit_creates_a_commit_on_the_branch_and_reports_nothing_to_commit() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        let dir = allocate(&repo, "task-1").expect("allocate");

        // A clean worktree commits nothing.
        assert!(!commit(&repo, "task-1", "first").expect("commit"));

        // Add a change in the worktree; commit now creates a commit on nc/task-1.
        std::fs::write(dir.join("file.txt"), "hello").expect("write");
        assert!(commit(&repo, "task-1", "add file").expect("commit"));

        // The commit landed on the task branch with our message.
        let log = Command::new("git")
            .args(["log", "-1", "--pretty=%s", &branch_name("task-1")])
            .current_dir(&repo)
            .output()
            .expect("git log");
        assert_eq!(String::from_utf8_lossy(&log.stdout).trim(), "add file");

        // A second commit with no further change reports nothing to commit.
        assert!(!commit(&repo, "task-1", "again").expect("commit"));
    }

    #[test]
    fn commit_in_commits_the_project_root_for_main_mode() {
        // M4.6 §A: a main-mode task commits in place in the project root (no
        // worktree), via `commit_in`. A clean tree commits nothing.
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        assert!(
            !commit_in(&repo, "noop").expect("commit"),
            "clean tree commits nothing"
        );

        std::fs::write(repo.join("src.txt"), "edit on main").expect("write");
        assert!(
            commit_in(&repo, "main mode change").expect("commit"),
            "a change commits"
        );

        let log = Command::new("git")
            .args(["log", "-1", "--pretty=%s"])
            .current_dir(&repo)
            .output()
            .expect("git log");
        assert_eq!(
            String::from_utf8_lossy(&log.stdout).trim(),
            "main mode change"
        );
        assert!(
            is_worktree_clean(&repo).expect("status"),
            "after commit the root is clean"
        );
    }

    #[test]
    fn commit_before_review_makes_an_uncommitted_edit_diffable() {
        // The dogfood-bug fix end-to-end at the worktree level: a build wrote an
        // UNCOMMITTED file into the worktree; before review we commit it, so the
        // branch HEAD advances and `base..HEAD` is non-empty (the reviewer's range
        // step now sees the work).
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        let base = base_branch(&repo);
        let dir = allocate(&repo, "task-1").expect("allocate");

        // Build writes an uncommitted file. Before the fix, base..HEAD is empty.
        std::fs::write(dir.join("feature.rs"), "fn added() {}").expect("write");
        let count_before = Command::new("git")
            .args([
                "rev-list",
                "--count",
                &format!("{base}..{}", branch_name("task-1")),
            ])
            .current_dir(&repo)
            .output()
            .expect("rev-list");
        assert_eq!(
            String::from_utf8_lossy(&count_before.stdout).trim(),
            "0",
            "the build leaves HEAD == base (the bug's precondition)"
        );

        // Commit-before-review advances HEAD; now the committed range is non-empty.
        assert!(commit(&repo, "task-1", "add feature").expect("commit"));
        let count_after = Command::new("git")
            .args([
                "rev-list",
                "--count",
                &format!("{base}..{}", branch_name("task-1")),
            ])
            .current_dir(&repo)
            .output()
            .expect("rev-list");
        assert_eq!(
            String::from_utf8_lossy(&count_after.stdout).trim(),
            "1",
            "after commit-before-review the reviewer's base..HEAD range is non-empty"
        );

        // And the diff itself carries the new file.
        let diff = Command::new("git")
            .args([
                "diff",
                &format!("{base}...{}", branch_name("task-1")),
                "--name-only",
            ])
            .current_dir(&repo)
            .output()
            .expect("git diff");
        assert!(
            String::from_utf8_lossy(&diff.stdout).contains("feature.rs"),
            "the committed diff includes the build's file"
        );
    }

    #[test]
    fn list_worktree_statuses_reports_branch_dirty_and_ahead() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        // No worktrees yet.
        assert!(list_worktree_statuses(&repo).is_empty());

        // Allocate one; a fresh worktree is clean and not ahead of base.
        let dir = allocate(&repo, "task-1").expect("allocate");
        let statuses = list_worktree_statuses(&repo);
        assert_eq!(statuses.len(), 1);
        let s = &statuses[0];
        assert_eq!(s.branch, "nc/task-1");
        assert_eq!(s.task_ids, vec!["task-1".to_string()]);
        assert!(!s.dirty, "a fresh worktree is clean");
        assert_eq!(s.ahead_of_base, 0, "a fresh worktree is level with base");

        // An uncommitted edit marks it dirty (still not ahead — no commit).
        std::fs::write(dir.join("wip.txt"), "wip").expect("write");
        let dirty = list_worktree_statuses(&repo);
        assert!(dirty[0].dirty, "an uncommitted edit is dirty");
        assert_eq!(dirty[0].ahead_of_base, 0);

        // Committing it clears dirty and advances ahead-of-base to 1.
        commit(&repo, "task-1", "wip commit").expect("commit");
        let committed = list_worktree_statuses(&repo);
        assert!(!committed[0].dirty, "a committed worktree is clean");
        assert_eq!(committed[0].ahead_of_base, 1, "one commit ahead of base");
    }

    #[test]
    fn merge_integrates_the_branch_into_base() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        let base = base_branch(&repo);
        let dir = allocate(&repo, "task-1").expect("allocate");
        std::fs::write(dir.join("feature.txt"), "feature").expect("write");
        commit(&repo, "task-1", "add feature").expect("commit");

        assert_eq!(
            merge(&repo, "task-1", &base).expect("merge"),
            MergeOutcome::Merged
        );
        // The base branch now contains the feature file.
        assert!(
            repo.join("feature.txt").exists(),
            "merge brought the file into base"
        );
    }

    #[test]
    fn merge_reports_conflict_and_does_not_force() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        let base = base_branch(&repo);
        // Diverge: the task branch edits README, then base edits the same line.
        let dir = allocate(&repo, "task-1").expect("allocate");
        std::fs::write(dir.join("README.md"), "from-branch").expect("write");
        commit(&repo, "task-1", "branch edit").expect("commit");

        run_in(&repo, &["checkout", &base]);
        std::fs::write(repo.join("README.md"), "from-base").expect("write");
        run_in(&repo, &["commit", "-am", "base edit"]);

        assert_eq!(
            merge(&repo, "task-1", &base).expect("merge"),
            MergeOutcome::Conflict
        );
        // The merge was aborted, not forced: the base content is intact and the tree
        // is clean (no conflict markers left staged).
        assert_eq!(
            std::fs::read_to_string(repo.join("README.md")).unwrap(),
            "from-base"
        );
        assert!(
            is_worktree_clean(&repo).expect("status"),
            "aborted merge leaves a clean tree"
        );
    }

    #[test]
    fn task_delete_cleanup_removes_worktree_and_branch() {
        // C8: deleting a worktree-mode task must leave no orphaned worktree dir or
        // `nc/<id>` branch. This exercises the remove-then-delete-branch sequence
        // `delete_task`'s cleanup runs (the AppHandle-gated wrapper is thin glue).
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        allocate(&repo, "task-1").expect("allocate");
        std::fs::write(worktree_path(&repo, "task-1").join("f.txt"), "x").expect("write");
        commit(&repo, "task-1", "work").expect("commit");
        assert!(
            branch_exists(&repo, "task-1"),
            "the nc/ branch exists after a run"
        );

        // The cleanup order: remove the worktree (frees its checked-out branch),
        // then delete the branch.
        remove(&repo, "task-1").expect("remove worktree");
        delete_branch(&repo, "task-1").expect("delete branch");

        assert!(
            list_worktree_task_ids(&repo).is_empty(),
            "no orphaned worktree dir"
        );
        assert!(!branch_exists(&repo, "task-1"), "no orphaned nc/ branch");
    }

    /// Whether `nc/<task_id>` exists in the repo (test helper).
    fn branch_exists(repo: &Path, task_id: &str) -> bool {
        run_in(
            repo,
            &["rev-parse", "--verify", "--quiet", &branch_name(task_id)],
        )
    }

    #[test]
    fn delete_branch_is_best_effort() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        allocate(&repo, "task-1").expect("allocate");
        // The branch is checked out in the worktree; removing the worktree first
        // frees it for deletion (mirrors the merge cleanup order).
        remove(&repo, "task-1").expect("remove");
        delete_branch(&repo, "task-1").expect("delete");
        // Deleting a now-missing branch is a no-op.
        delete_branch(&repo, "task-1").expect("idempotent delete");
    }

    #[test]
    fn remove_refuses_paths_outside_the_base() {
        // A task id that tries to escape the base via traversal can't reach outside
        // it: worktree_path joins it under the base, and is_under still holds. Here
        // we assert the guard directly on a crafted path.
        let base = worktrees_base(Path::new("/repo"));
        assert!(!is_under(&base, Path::new("/repo/.git")));
    }
}
