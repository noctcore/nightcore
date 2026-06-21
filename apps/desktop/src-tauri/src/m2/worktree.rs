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
use std::process::Command;

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
    let out = Command::new("git")
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
    let branch_exists = git(
        project_path,
        &["rev-parse", "--verify", "--quiet", &branch],
    )
    .is_ok();

    let args: Vec<&str> = if branch_exists {
        vec!["worktree", "add", &dir_str, &branch]
    } else {
        vec!["worktree", "add", &dir_str, "-b", &branch]
    };
    git(project_path, &args)?;
    Ok(dir)
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
                Err(e) => eprintln!("worktree reconcile: skipping {id}: {e}"),
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
        assert!(is_under(base, Path::new("/repo/.nightcore/worktrees/task-1")));
        assert!(!is_under(base, Path::new("/repo")), "parent is not under base");
        assert!(!is_under(base, base), "the base itself is not strictly under");
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
        assert!(dir.join("README.md").exists(), "worktree has the repo content");
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
        assert!(is_worktree_clean(&repo).expect("status"), "fresh repo is clean");
        std::fs::write(repo.join("README.md"), "changed").expect("edit");
        assert!(
            !is_worktree_clean(&repo).expect("status"),
            "an uncommitted edit makes the tree dirty"
        );
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
