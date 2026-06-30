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

/// Create a worktree for `task_id` checked out on `branch`, branching off `base`
/// when `branch` doesn't exist yet (else the existing branch is resumed and `base`
/// is ignored). The branch/base-aware variant of [`allocate`], used when the create
/// dialog's branch picker supplied a custom branch and/or base. Idempotent: an
/// existing worktree dir is reused.
pub fn allocate_branch(
    project_path: &Path,
    task_id: &str,
    branch: &str,
    base: &str,
) -> Result<PathBuf, String> {
    let dir = worktree_path(project_path, task_id);
    if dir.exists() {
        return Ok(dir); // already allocated (crash recovery / re-run)
    }
    std::fs::create_dir_all(worktrees_base(project_path))
        .map_err(|e| format!("failed to create worktrees base: {e}"))?;
    let dir_str = dir.to_string_lossy().to_string();
    let branch_exists = git(project_path, &["rev-parse", "--verify", "--quiet", branch]).is_ok();
    let args: Vec<&str> = if branch_exists {
        // Resume an existing branch in a fresh worktree (base is irrelevant).
        vec!["worktree", "add", &dir_str, branch]
    } else {
        // Create `branch` off `base`.
        vec!["worktree", "add", &dir_str, "-b", branch, base]
    };
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
    if git(project_path, &["worktree", "remove", "--force", &dir_str]).is_ok() {
        return Ok(());
    }
    // `git worktree remove` can fail on a locked admin file or untracked build
    // artifacts (node_modules, macOS `.app` bundles). Fall back to a bounded retry,
    // then a manual recursive delete + `worktree prune` to clear the admin refs
    // (Aperant's cross-platform cleanup). Still confined to the `is_under`-guarded
    // dir, so this can never touch the user's main checkout.
    remove_dir_with_retry(&dir)?;
    let _ = git(project_path, &["worktree", "prune"]);
    Ok(())
}

/// Recursively delete `dir` with a bounded linear backoff, tolerating the transient
/// file locks that make a first delete fail (a lingering file handle). The caller
/// has already `is_under`-guarded `dir`.
fn remove_dir_with_retry(dir: &Path) -> Result<(), String> {
    const MAX_ATTEMPTS: usize = 3;
    let mut last_err = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                last_err = e.to_string();
                if attempt + 1 < MAX_ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(
                        200 * (attempt as u64 + 1),
                    ));
                }
            }
        }
    }
    Err(format!(
        "failed to remove worktree dir {}: {last_err}",
        dir.display()
    ))
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
    merge_branch(project_path, &branch_name(task_id), base_branch)
}

/// Merge `branch` into `base` in the project's main checkout — only via `git merge`
/// (never `--force`/reset). Refuses a dirty base; on any merge failure runs `merge
/// --abort` and returns `Conflict`, leaving a clean tree. The branch-explicit
/// variant of [`merge`], used for picker-chosen branch names.
pub fn merge_branch(
    project_path: &Path,
    branch: &str,
    base: &str,
) -> Result<MergeOutcome, String> {
    // The base branch must be checked out to receive the merge. Refuse if the main
    // tree is dirty so we never merge over uncommitted work.
    if !is_worktree_clean(project_path)? {
        return Err("base working tree is dirty; commit or stash before merging".to_string());
    }
    git(project_path, &["checkout", base])?;

    if git_status_success(project_path, &["merge", "--no-edit", branch]) {
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
    delete_branch_named(project_path, &branch_name(task_id))
}

/// Delete a specific `branch` (best-effort). Refuses to delete the project's current
/// base branch / `HEAD` — an exact-match safety guard (Aperant) so a bad or
/// user-supplied branch value can never delete the user's working branch. A missing
/// branch is a no-op.
pub fn delete_branch_named(project_path: &Path, branch: &str) -> Result<(), String> {
    if branch.is_empty() {
        return Ok(());
    }
    if branch == "HEAD" || branch == base_branch(project_path) {
        return Err(format!(
            "refusing to delete branch {branch} — it is the project's base branch"
        ));
    }
    if git_status_success(project_path, &["rev-parse", "--verify", "--quiet", branch]) {
        git(project_path, &["branch", "-D", branch])?;
    }
    Ok(())
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
    let porcelain = git(dir, &["status", "--porcelain"]).unwrap_or_default();
    let dirty = !porcelain.is_empty();
    let changed_files = if porcelain.is_empty() {
        0
    } else {
        porcelain.lines().count() as u32
    };
    let range = format!("{base}...HEAD");
    let (behind_of_base, ahead_of_base) = git(dir, &["rev-list", "--left-right", "--count", &range])
        .ok()
        .and_then(|s| parse_left_right_count(&s))
        .unwrap_or((0, 0));
    WorktreeStatus {
        branch: branch_name(task_id),
        path: dir.to_string_lossy().to_string(),
        task_ids: vec![task_id.to_string()],
        dirty,
        ahead_of_base,
        behind_of_base,
        changed_files,
    }
}

/// Parse `git rev-list --left-right --count <base>...HEAD` output (`"<behind>\t<ahead>"`)
/// into `(behind, ahead)`: the left count is commits reachable from `base` but not
/// HEAD (behind), the right is HEAD-only (ahead). `None` on malformed output.
fn parse_left_right_count(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.split_whitespace();
    let behind = parts.next()?.parse::<u32>().ok()?;
    let ahead = parts.next()?.parse::<u32>().ok()?;
    Some((behind, ahead))
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

// ─── Branch listing (branch picker) ────────────────────────────────────────────

/// One branch for the branch picker. Local branches carry upstream + ahead/behind
/// tracking; remote-tracking branches carry name only.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "BranchInfo.ts"))]
pub struct BranchInfo {
    /// Short branch name (`main`, `nc/abc`, or `origin/main` for a remote).
    pub name: String,
    /// Whether this is a remote-tracking branch (`refs/remotes/*`).
    pub is_remote: bool,
    /// Whether this is the currently checked-out branch in the project's main tree.
    pub is_current: bool,
    /// The upstream this local branch tracks (`origin/main`), if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub upstream: Option<String>,
    /// Commits ahead of upstream (local branches with an upstream only).
    pub ahead: u32,
    /// Commits behind upstream.
    pub behind: u32,
}

/// List the project's branches — local (`refs/heads`) with upstream + ahead/behind,
/// then remote-tracking (`refs/remotes`, name only) — for the branch picker. Uses a
/// stable `for-each-ref` format under `LC_ALL=C`. Tolerant: a failed read yields an
/// empty list so the picker degrades to free-form branch entry.
pub fn list_branches(project_path: &Path) -> Vec<BranchInfo> {
    let mut branches = Vec::new();
    if let Ok(out) = git(
        project_path,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(upstream:track,nobracket)",
            "refs/heads",
        ],
    ) {
        for line in out.lines() {
            let mut f = line.split('\t');
            let name = f.next().unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            let is_current = f.next().map(|h| h.trim() == "*").unwrap_or(false);
            let upstream = f.next().filter(|s| !s.is_empty()).map(str::to_string);
            let (ahead, behind) = parse_track(f.next().unwrap_or(""));
            branches.push(BranchInfo {
                name,
                is_remote: false,
                is_current,
                upstream,
                ahead,
                behind,
            });
        }
    }
    if let Ok(out) = git(
        project_path,
        &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
    ) {
        for line in out.lines() {
            let name = line.trim().to_string();
            // Skip the symbolic `origin/HEAD` pointer — it is not a real branch.
            if name.is_empty() || name.ends_with("/HEAD") {
                continue;
            }
            branches.push(BranchInfo {
                name,
                is_remote: true,
                is_current: false,
                upstream: None,
                ahead: 0,
                behind: 0,
            });
        }
    }
    branches
}

/// Parse `git for-each-ref %(upstream:track,nobracket)` text (`"ahead 2, behind 1"`,
/// `"ahead 3"`, `"behind 4"`, `"gone"`, or empty) into `(ahead, behind)`.
fn parse_track(s: &str) -> (u32, u32) {
    let mut ahead = 0;
    let mut behind = 0;
    for part in s.split(',') {
        let p = part.trim();
        if let Some(n) = p.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = p.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

// ─── Diff stats (merge preview + worktree diff) ────────────────────────────────

/// Per-file line-change counts for a diff range (`git diff --numstat`).
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "DiffFileStat.ts"))]
pub struct DiffFileStat {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

/// Parse `git diff --numstat <range>` into per-file stats + totals. Binary files
/// (`-\t-\tpath`) contribute `0/0`.
fn diff_numstat(repo: &Path, range: &str) -> (Vec<DiffFileStat>, u32, u32) {
    let out = git(repo, &["diff", "--numstat", range]).unwrap_or_default();
    let mut files = Vec::new();
    let mut add_total = 0;
    let mut del_total = 0;
    for line in out.lines() {
        let mut f = line.splitn(3, '\t');
        let add = f.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
        let del = f.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
        let Some(path) = f.next().map(str::to_string).filter(|p| !p.is_empty()) else {
            continue;
        };
        add_total += add;
        del_total += del;
        files.push(DiffFileStat {
            path,
            additions: add,
            deletions: del,
        });
    }
    (files, add_total, del_total)
}

// ─── Merge preview (read-only) ─────────────────────────────────────────────────

/// The outcome of a read-only merge preview.
#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "MergePreviewStatus.ts"))]
pub enum MergePreviewStatus {
    /// Branch is level with base — nothing to merge.
    UpToDate,
    /// Branch is ahead of base and merges cleanly.
    Ready,
    /// Branch and base diverged but still merge cleanly.
    Diverged,
    /// Merging would conflict (the merge is NOT performed — preview only).
    Conflicts,
}

/// A read-only preview of merging `branch` into `base`: status, the files that would
/// conflict, the changed-file stats, and ahead/behind counts. Computed without
/// touching the working tree (`git merge-tree --write-tree`), so it is safe to call
/// freely (Aperant's merge-preview, automaker's multi-layer conflict detection).
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "MergePreview.ts"))]
pub struct MergePreview {
    /// The merge status (up-to-date / ready / diverged / conflicts).
    pub status: MergePreviewStatus,
    /// The branch being previewed.
    pub branch: String,
    /// The base branch the merge would target.
    pub base: String,
    /// Files that would conflict. Empty when none; also empty in the rare "unknown"
    /// case (the `status` carries the conflict signal regardless).
    pub conflict_files: Vec<String>,
    /// Per-file change stats of `base...branch`.
    pub files: Vec<DiffFileStat>,
    /// Total added lines across `files`.
    pub additions: u32,
    /// Total deleted lines across `files`.
    pub deletions: u32,
    /// Commits the branch is ahead of base.
    pub ahead: u32,
    /// Commits the branch is behind base.
    pub behind: u32,
}

/// Preview merging `branch` into `base` — READ-ONLY (never mutates the working tree).
pub fn merge_preview(project_path: &Path, branch: &str, base: &str) -> MergePreview {
    let range = format!("{base}...{branch}");
    let (behind, ahead) = git(project_path, &["rev-list", "--left-right", "--count", &range])
        .ok()
        .and_then(|s| parse_left_right_count(&s))
        .unwrap_or((0, 0));
    let (files, additions, deletions) = diff_numstat(project_path, &range);
    let (status, conflict_files) = match detect_merge_conflicts(project_path, base, branch) {
        ConflictDetection::Conflicts(f) => (MergePreviewStatus::Conflicts, f),
        _ => {
            let status = if ahead == 0 {
                MergePreviewStatus::UpToDate
            } else if behind > 0 {
                MergePreviewStatus::Diverged
            } else {
                MergePreviewStatus::Ready
            };
            (status, Vec::new())
        }
    };
    MergePreview {
        status,
        branch: branch.to_string(),
        base: base.to_string(),
        conflict_files,
        files,
        additions,
        deletions,
        ahead,
        behind,
    }
}

/// Read-only conflict detection result.
enum ConflictDetection {
    /// The merge applies cleanly.
    Clean,
    /// The merge conflicts; the named files are unmergeable.
    Conflicts(Vec<String>),
    /// Could not be determined (old git without `--write-tree`, or a bad ref).
    Unknown,
}

/// Detect whether merging `branch` into `base` conflicts, WITHOUT touching the tree,
/// via `git merge-tree --write-tree --name-only` (git ≥ 2.38). Exit 0 = clean, exit
/// 1 = conflicts (stdout lists the files after the tree OID), anything else (or an
/// old git lacking the flag) = unknown.
fn detect_merge_conflicts(project_path: &Path, base: &str, branch: &str) -> ConflictDetection {
    let Ok(out) = crate::platform::git_command(project_path)
        .args(["merge-tree", "--write-tree", "--name-only", base, branch])
        .output()
    else {
        return ConflictDetection::Unknown;
    };
    if out.status.success() {
        return ConflictDetection::Clean;
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("usage:") || stderr.contains("unknown option") || stderr.contains("error:") {
        return ConflictDetection::Unknown;
    }
    if out.status.code() == Some(1) {
        let stdout = String::from_utf8_lossy(&out.stdout);
        // `<tree-oid>\n<conflicted file>…\n\n<informational messages>`: take the
        // file-name section up to the first blank line.
        let files: Vec<String> = stdout
            .lines()
            .skip(1)
            .take_while(|l| !l.trim().is_empty())
            .map(|l| l.trim().to_string())
            .collect();
        return ConflictDetection::Conflicts(files);
    }
    ConflictDetection::Unknown
}

// ─── Worktree diff (working-tree inclusive) ────────────────────────────────────

/// The change kind of a file in a worktree diff.
#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "DiffStatus.ts"))]
pub enum DiffStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
}

/// One changed file in a worktree diff vs base.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "WorktreeDiffFile.ts"))]
pub struct WorktreeDiffFile {
    pub path: String,
    pub status: DiffStatus,
    pub additions: u32,
    pub deletions: u32,
}

/// The changed files in a worktree vs its base branch — committed AND uncommitted,
/// plus untracked — so the reviewer/UI sees the real state (an empty `base..HEAD`
/// does not mean "no changes"; uncommitted edits exist). Tolerant: failed reads
/// degrade to fewer entries rather than erroring.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "WorktreeDiff.ts"))]
pub struct WorktreeDiff {
    pub files: Vec<WorktreeDiffFile>,
    pub summary: String,
    pub additions: u32,
    pub deletions: u32,
}

/// Compute the worktree's changed files vs `base` (committed + uncommitted tracked
/// changes via `git diff <base>`, plus untracked files).
pub fn worktree_diff(dir: &Path, base: &str) -> WorktreeDiff {
    use std::collections::HashMap;
    refresh_index(dir);
    let mut stats: HashMap<String, (u32, u32)> = HashMap::new();
    if let Ok(numstat) = git(dir, &["diff", "--numstat", base]) {
        for line in numstat.lines() {
            let mut f = line.splitn(3, '\t');
            let add = f.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
            let del = f.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
            if let Some(path) = f.next() {
                if !path.is_empty() {
                    stats.insert(path.to_string(), (add, del));
                }
            }
        }
    }
    let mut files = Vec::new();
    let mut add_total = 0;
    let mut del_total = 0;
    if let Ok(name_status) = git(dir, &["diff", "--name-status", base]) {
        for line in name_status.lines() {
            let mut f = line.splitn(2, '\t');
            let code = f.next().unwrap_or("");
            let Some(path) = f.next().map(str::to_string).filter(|p| !p.is_empty()) else {
                continue;
            };
            let status = match code.chars().next() {
                Some('A') => DiffStatus::Added,
                Some('D') => DiffStatus::Deleted,
                Some('R') => DiffStatus::Renamed,
                _ => DiffStatus::Modified,
            };
            let (a, d) = stats.get(&path).copied().unwrap_or((0, 0));
            add_total += a;
            del_total += d;
            files.push(WorktreeDiffFile {
                path,
                status,
                additions: a,
                deletions: d,
            });
        }
    }
    if let Ok(untracked) = git(dir, &["ls-files", "--others", "--exclude-standard"]) {
        for path in untracked.lines() {
            let path = path.trim();
            if !path.is_empty() {
                files.push(WorktreeDiffFile {
                    path: path.to_string(),
                    status: DiffStatus::Untracked,
                    additions: 0,
                    deletions: 0,
                });
            }
        }
    }
    let summary = format!(
        "{} file{} changed, +{add_total} -{del_total}",
        files.len(),
        if files.len() == 1 { "" } else { "s" }
    );
    WorktreeDiff {
        files,
        summary,
        additions: add_total,
        deletions: del_total,
    }
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

    #[test]
    fn stage_diff_commit_split_helpers_round_trip() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        // A clean tree stages nothing.
        stage_all(&repo).expect("stage");
        assert!(!has_staged_changes(&repo), "clean tree has nothing staged");

        // Introduce a change, stage it, and see it through the diff helpers — this is
        // the window the commit-message generator reads between staging and committing.
        std::fs::write(repo.join("feature.txt"), "new feature\n").expect("write");
        stage_all(&repo).expect("stage");
        assert!(has_staged_changes(&repo), "the new file is staged");
        let diff = staged_diff(&repo).expect("diff");
        assert!(
            diff.contains("feature.txt"),
            "the staged diff names the file: {diff}"
        );

        // Commit the already-staged change; the tree goes clean and the message lands.
        commit_staged(&repo, "feat: add feature").expect("commit");
        assert!(!has_staged_changes(&repo), "post-commit tree is clean");
        let log = Command::new("git")
            .args(["log", "-1", "--pretty=%s"])
            .current_dir(&repo)
            .output()
            .expect("git log");
        assert_eq!(
            String::from_utf8_lossy(&log.stdout).trim(),
            "feat: add feature"
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
        assert_eq!(s.behind_of_base, 0, "a fresh worktree is not behind base");
        assert_eq!(s.changed_files, 0, "a fresh worktree has no changed files");

        // An uncommitted edit marks it dirty with one changed file (still not ahead).
        std::fs::write(dir.join("wip.txt"), "wip").expect("write");
        let dirty = list_worktree_statuses(&repo);
        assert!(dirty[0].dirty, "an uncommitted edit is dirty");
        assert_eq!(dirty[0].ahead_of_base, 0);
        assert_eq!(dirty[0].changed_files, 1, "one uncommitted file");

        // Committing it clears dirty and advances ahead-of-base to 1, not behind.
        commit(&repo, "task-1", "wip commit").expect("commit");
        let committed = list_worktree_statuses(&repo);
        assert!(!committed[0].dirty, "a committed worktree is clean");
        assert_eq!(committed[0].ahead_of_base, 1, "one commit ahead of base");
        assert_eq!(committed[0].behind_of_base, 0, "not behind base");
        assert_eq!(committed[0].changed_files, 0, "no changed files after commit");
    }

    #[test]
    fn parse_left_right_count_reads_behind_then_ahead() {
        assert_eq!(parse_left_right_count("3\t5"), Some((3, 5)));
        assert_eq!(parse_left_right_count("0 0"), Some((0, 0)));
        assert_eq!(parse_left_right_count(""), None);
        assert_eq!(parse_left_right_count("nope"), None);
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

    #[test]
    fn list_branches_includes_the_current_branch() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        let branches = list_branches(&repo);
        let current = branches
            .iter()
            .find(|b| b.is_current)
            .expect("a current branch");
        assert!(!current.is_remote, "the checked-out branch is local");
        assert_eq!(current.name, base_branch(&repo));
    }

    #[test]
    fn merge_preview_reports_ready_then_conflict() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        let base = base_branch(&repo);
        let dir = allocate(&repo, "task-1").expect("allocate");
        std::fs::write(dir.join("feature.txt"), "feature\n").expect("write");
        commit(&repo, "task-1", "add feature").expect("commit");

        let preview = merge_preview(&repo, &branch_name("task-1"), &base);
        assert_eq!(preview.status, MergePreviewStatus::Ready);
        assert!(preview.conflict_files.is_empty());
        assert_eq!(preview.ahead, 1);
        assert_eq!(preview.behind, 0);
        assert!(preview.files.iter().any(|f| f.path == "feature.txt"));

        // Diverge base on a line the branch also edits → conflict preview.
        let dir2 = allocate(&repo, "task-2").expect("allocate 2");
        std::fs::write(dir2.join("README.md"), "from-branch\n").expect("write");
        commit(&repo, "task-2", "branch edit").expect("commit");
        run_in(&repo, &["checkout", &base]);
        std::fs::write(repo.join("README.md"), "from-base\n").expect("write");
        run_in(&repo, &["commit", "-am", "base edit"]);

        let conflict = merge_preview(&repo, &branch_name("task-2"), &base);
        // Modern git (≥2.38) detects the conflict precisely; older git can only see
        // the divergence — accept either, and verify the file list when conflicting.
        assert!(
            matches!(
                conflict.status,
                MergePreviewStatus::Conflicts | MergePreviewStatus::Diverged
            ),
            "expected conflicts-or-diverged, got {:?}",
            conflict.status
        );
        if matches!(conflict.status, MergePreviewStatus::Conflicts) {
            assert!(
                conflict.conflict_files.iter().any(|f| f == "README.md"),
                "conflict files should name README.md: {:?}",
                conflict.conflict_files
            );
        }
        // The preview is read-only: the base tree is untouched.
        assert!(
            is_worktree_clean(&repo).expect("status"),
            "merge_preview must not mutate the working tree"
        );
    }

    #[test]
    fn worktree_diff_lists_committed_and_untracked() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        let base = base_branch(&repo);
        let dir = allocate(&repo, "task-1").expect("allocate");
        std::fs::write(dir.join("added.txt"), "a\nb\n").expect("write");
        commit(&repo, "task-1", "add file").expect("commit");
        // An uncommitted untracked file is also part of the worktree's diff.
        std::fs::write(dir.join("scratch.txt"), "wip\n").expect("write");

        let diff = worktree_diff(&dir, &base);
        assert!(
            diff.files
                .iter()
                .any(|f| f.path == "added.txt" && matches!(f.status, DiffStatus::Added)),
            "committed add should appear: {:?}",
            diff.files
        );
        assert!(
            diff.files
                .iter()
                .any(|f| f.path == "scratch.txt" && matches!(f.status, DiffStatus::Untracked)),
            "untracked file should appear: {:?}",
            diff.files
        );
        assert!(diff.additions >= 2, "added.txt has 2 lines: {}", diff.summary);
    }

    #[test]
    fn allocate_branch_creates_named_branch_off_base_then_merges() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        let base = base_branch(&repo);
        // Allocate a worktree on a picker-chosen branch name off the base.
        let dir = allocate_branch(&repo, "task-1", "feature/foo", &base).expect("allocate_branch");
        assert!(dir.is_dir());
        let head = Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&dir)
            .output()
            .expect("head");
        assert_eq!(
            String::from_utf8_lossy(&head.stdout).trim(),
            "feature/foo",
            "the worktree is checked out on the chosen branch"
        );
        // A commit on that branch merges cleanly back into base via merge_branch.
        std::fs::write(dir.join("f.txt"), "x").expect("write");
        commit(&repo, "task-1", "work").expect("commit");
        assert_eq!(
            merge_branch(&repo, "feature/foo", &base).expect("merge"),
            MergeOutcome::Merged
        );
        assert!(repo.join("f.txt").exists(), "merge integrated the file");
    }
}
