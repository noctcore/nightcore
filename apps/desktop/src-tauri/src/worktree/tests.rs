//! Integration tests for the worktree module.
//!
//! These build a real temp git repo (skipping when `git` is unavailable so the
//! suite stays green in minimal envs) and exercise the full lifecycle across the
//! submodules through the re-exported facade. The pure path/guard unit tests live
//! next to their code in `path.rs`.

use super::*;
use std::path::{Path, PathBuf};
use std::process::Command;

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
    assert_eq!(
        committed[0].changed_files, 0,
        "no changed files after commit"
    );
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
        merge_branch(&repo, &branch_name("task-1"), &base).expect("merge"),
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
        merge_branch(&repo, &branch_name("task-1"), &base).expect("merge"),
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
fn merge_of_nonexistent_branch_errors_not_conflict() {
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    let base = base_branch(&repo);
    // A branch that doesn't exist is a hard merge failure — git starts no merge —
    // so the caller must see an `Err`, NOT a `Conflict` (the UI would otherwise
    // tell the user "conflict" for a failure that isn't one).
    let outcome = merge_branch(&repo, &branch_name("does-not-exist"), &base);
    assert!(
        outcome.is_err(),
        "a nonexistent branch is an error, not a conflict: {outcome:?}"
    );
    // No merge was started, so the base tree is left clean (not mid-merge).
    assert!(
        is_worktree_clean(&repo).expect("status"),
        "a merge that never started leaves the tree clean"
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
    delete_branch_named(&repo, &branch_name("task-1")).expect("delete branch");

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
    delete_branch_named(&repo, &branch_name("task-1")).expect("delete");
    // Deleting a now-missing branch is a no-op.
    delete_branch_named(&repo, &branch_name("task-1")).expect("idempotent delete");
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
    assert!(
        diff.additions >= 2,
        "added.txt has 2 lines: {}",
        diff.summary
    );
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
    // worktree_status reports the REAL checked-out branch (so the web groups the
    // task by its actual branch), not the derived `nc/<id>`.
    assert_eq!(
        worktree_status(&dir, "task-1", &base).branch,
        "feature/foo",
        "worktree_status reports the actual branch, not nc/<taskId>"
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

#[test]
fn allocate_branch_rejects_a_dash_branch_before_touching_git() {
    // A picker value that git would parse as an option must be refused up front,
    // never spliced into `git worktree add` (defence in depth with the ingestion
    // filter and the `--end-of-options` separators).
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    let base = base_branch(&repo);
    let err =
        allocate_branch(&repo, "task-1", "-D", &base).expect_err("a dash-branch must be rejected");
    assert!(err.contains("invalid branch/base name"), "err was: {err}");
    // Nothing was allocated.
    assert!(
        list_worktree_task_ids(&repo).is_empty(),
        "a rejected allocate must not create a worktree"
    );

    // A hostile BASE (used only when the branch is new) is rejected too.
    let err_base = allocate_branch(&repo, "task-2", "feature/ok", "--all")
        .expect_err("a dash-base must be rejected");
    assert!(
        err_base.contains("invalid branch/base name"),
        "err: {err_base}"
    );
}

#[test]
fn merge_and_delete_reject_dash_refs() {
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    let base = base_branch(&repo);
    assert!(
        merge_branch(&repo, "--all", &base).is_err(),
        "a dash-branch merge must be rejected"
    );
    assert!(
        merge_branch(&repo, "feature/ok", "-D").is_err(),
        "a dash-base merge must be rejected"
    );
    assert!(
        delete_branch_named(&repo, "-D").is_err(),
        "a dash-branch delete must be rejected"
    );
    // An empty branch stays a no-op (not an error) — callers rely on that.
    assert!(
        delete_branch_named(&repo, "").is_ok(),
        "an empty branch is a no-op, not an error"
    );
}

#[test]
fn remote_url_reports_origin_or_none() {
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    assert!(
        remote_url(&repo).is_none(),
        "a repo without an origin remote reports None"
    );
    assert!(run_in(
        &repo,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/widget.git",
        ],
    ));
    assert_eq!(
        remote_url(&repo).as_deref(),
        Some("https://github.com/acme/widget.git")
    );
}

#[test]
fn push_branch_pushes_to_origin_idempotently_and_rejects_dash_refs() {
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    // A local bare repo stands in for the remote so the test needs no network.
    let bare = tempfile::TempDir::new().expect("bare dir");
    assert!(Command::new("git")
        .args(["init", "-q", "--bare"])
        .current_dir(bare.path())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false));
    assert!(run_in(
        &repo,
        &["remote", "add", "origin", bare.path().to_str().unwrap()],
    ));

    let dir = allocate(&repo, "task-1").expect("allocate");
    std::fs::write(dir.join("f.txt"), "x").expect("write");
    commit(&repo, "task-1", "work").expect("commit");

    push_branch(&dir, &branch_name("task-1")).expect("push");
    let ls = Command::new("git")
        .args(["ls-remote", "--heads", "origin", &branch_name("task-1")])
        .current_dir(&dir)
        .output()
        .expect("ls-remote");
    assert!(
        String::from_utf8_lossy(&ls.stdout).contains("refs/heads/nc/task-1"),
        "the branch landed on the remote"
    );
    // Re-pushing an already-pushed branch is a no-op (the re-runnable contract).
    push_branch(&dir, &branch_name("task-1")).expect("re-push is idempotent");
    // Option-injection refs are refused before any git spawn (never --force).
    assert!(
        push_branch(&dir, "--force").is_err(),
        "a dash-ref push must be rejected"
    );
    assert!(
        push_branch(&dir, "-D").is_err(),
        "a dash-ref push must be rejected"
    );
}

#[test]
fn try_ahead_of_upstream_counts_unpushed_commits_and_fails_closed() {
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    // A local bare repo stands in for the remote (no network).
    let bare = tempfile::TempDir::new().expect("bare dir");
    assert!(Command::new("git")
        .args(["init", "-q", "--bare"])
        .current_dir(bare.path())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false));
    assert!(run_in(
        &repo,
        &["remote", "add", "origin", bare.path().to_str().unwrap()],
    ));

    let dir = allocate(&repo, "task-1").expect("allocate");
    // No upstream yet (never pushed): Err, NEVER a silent 0 — a destructive
    // caller cannot verify anything was pushed.
    assert!(
        try_ahead_of_upstream(&dir).is_err(),
        "no upstream is Err, not 0"
    );
    std::fs::write(dir.join("f.txt"), "x").expect("write");
    commit(&repo, "task-1", "work").expect("commit");
    assert!(try_ahead_of_upstream(&dir).is_err(), "still no upstream");

    // Pushing sets the upstream (`push -u`); level ⇒ 0.
    push_branch(&dir, &branch_name("task-1")).expect("push");
    assert_eq!(
        try_ahead_of_upstream(&dir),
        Ok(0),
        "level with upstream after push"
    );

    // A local commit that never reached the remote counts as unpushed.
    std::fs::write(dir.join("g.txt"), "y").expect("write");
    commit(&repo, "task-1", "more").expect("commit 2");
    assert_eq!(
        try_ahead_of_upstream(&dir),
        Ok(1),
        "one unpushed commit"
    );
    push_branch(&dir, &branch_name("task-1")).expect("re-push");
    assert_eq!(
        try_ahead_of_upstream(&dir),
        Ok(0),
        "re-pushing clears the count"
    );

    // THE FAIL-OPEN SHAPE: prune the remote-tracking ref (what any `fetch
    // --prune` does after GitHub auto-deleted the merged head branch) — the
    // upstream is configured but `@{upstream}` no longer resolves. One more
    // local commit exists only here; the count MUST be Err, not 0.
    std::fs::write(dir.join("h.txt"), "z").expect("write");
    commit(&repo, "task-1", "late fix").expect("commit 3");
    let tracking = format!("refs/remotes/origin/{}", branch_name("task-1"));
    assert!(
        run_in(&dir, &["update-ref", "-d", &tracking]),
        "prune the remote-tracking ref"
    );
    assert!(
        try_ahead_of_upstream(&dir).is_err(),
        "a pruned upstream is Err — the old tolerant 0 silently bypassed the \
         finalize refusal and destroyed the unpushed commit"
    );
}

#[test]
fn current_branch_is_strict_about_detached_head() {
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    // On a named branch it agrees with base_branch…
    assert_eq!(current_branch(&repo).as_deref(), Some(&*base_branch(&repo)));
    // …but a detached HEAD reads as None (base_branch would fall back to
    // "main" — the strict read must refuse to guess).
    assert!(run_in(&repo, &["checkout", "-q", "--detach"]));
    assert_eq!(current_branch(&repo), None);
}

#[test]
fn fetch_base_and_merge_ff_only_reject_dash_refs() {
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    for bad in ["--force", "-D"] {
        assert!(
            fetch_base(&repo, bad).is_err(),
            "a dash-ref fetch must be rejected"
        );
        assert!(
            merge_ff_only(&repo, bad).is_err(),
            "a dash-ref ff-merge must be rejected"
        );
    }
}

#[test]
fn base_diff_reports_committed_changes_and_rejects_dash_base() {
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    let base = base_branch(&repo);
    let dir = allocate(&repo, "task-1").expect("allocate");

    // Level with base: the committed diff is empty.
    let empty = base_diff(&dir, &base).expect("diff");
    assert!(empty.trim().is_empty(), "level branch has no diff: {empty}");

    std::fs::write(dir.join("feature.txt"), "feature\n").expect("write");
    commit(&repo, "task-1", "add feature").expect("commit");
    let diff = base_diff(&dir, &base).expect("diff");
    assert!(
        diff.contains("feature.txt"),
        "the committed diff names the file: {diff}"
    );

    // A base git would parse as an option is refused before reaching argv.
    assert!(base_diff(&dir, "-D").is_err());
}

/// The base-branch guard matches on identity, not one spelling: neither a qualified
/// ref (`refs/heads/main`) nor a case variant (`Main` — which `git branch -D`
/// case-folds and deletes on macOS/Windows) may bypass it.
#[test]
fn delete_refuses_base_branch_under_equivalent_spellings() {
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    let base = base_branch(&repo);
    let head_sha = |r: &Path| {
        String::from_utf8(
            Command::new("git")
                .args(["rev-parse", "--verify", &base])
                .current_dir(r)
                .output()
                .expect("rev-parse base")
                .stdout,
        )
        .ok()
    };
    let before = head_sha(&repo).expect("base resolves before");

    for spelling in [
        base.clone(),                 // exact short name
        base.to_uppercase(),          // case variant (case-fold delete on macOS/Windows)
        format!("refs/heads/{base}"), // fully-qualified ref
        format!("heads/{base}"),      // partially-qualified ref
        "HEAD".to_string(),           // the literal HEAD
    ] {
        assert!(
            delete_branch_named(&repo, &spelling).is_err(),
            "guard must refuse base-branch spelling {spelling:?}"
        );
        assert_eq!(
            head_sha(&repo).as_deref(),
            Some(before.as_str()),
            "base branch must still exist after refusing {spelling:?}"
        );
    }

    // Positive control: a genuine non-base branch is still deletable.
    assert!(
        run_in(&repo, &["branch", "feature/keepable"]),
        "create a deletable branch"
    );
    delete_branch_named(&repo, "feature/keepable").expect("non-base branch deletes");
    assert!(
        !run_in(
            &repo,
            &["rev-parse", "--verify", "--quiet", "feature/keepable"]
        ),
        "the non-base branch was deleted"
    );
}
