//! Unit tests for the commit/merge lease discipline and the pure refusal guards.

use super::commit::{commit_message, refuse_commit_while_merge_in_flight};
use super::integrate::{refuse_main_mode_merge, refuse_while_pr_in_flight};
use super::lease::{commit_in_flight, merge_in_flight, TaskLease};
use crate::task::Task;

#[test]
fn commit_message_uses_title_or_falls_back() {
    let mut task = Task::new("Add login form".into(), String::new());
    assert_eq!(commit_message(&task), "Add login form");

    task.title = "   ".into();
    assert!(commit_message(&task).contains(&task.id));
}

#[test]
fn merge_refused_for_main_mode_allowed_for_worktree() {
    use crate::task::RunMode;
    // M4.6 §A.3: a main-mode task (the default) has no branch to merge.
    let main_task = Task::new("edit on main".into(), String::new());
    assert_eq!(main_task.run_mode, RunMode::Main);
    let err = refuse_main_mode_merge(&main_task).expect_err("main mode must be refused");
    assert!(
        err.contains("runs on main"),
        "the message explains the refusal: {err}"
    );
    assert!(
        err.contains("commit"),
        "the message points at commit instead"
    );

    // A worktree-mode task passes the guard (it has a branch to integrate).
    let wt_task = Task::new("isolated".into(), String::new()).with_run_mode(RunMode::Worktree);
    assert!(
        refuse_main_mode_merge(&wt_task).is_ok(),
        "worktree mode is mergeable"
    );
}

#[test]
fn task_lease_is_single_flight_per_set_and_releases_on_drop() {
    // Pins the invariant that replaced the main-thread serialization lost when
    // commit_task / merge_task moved to the blocking pool: at most one in-flight
    // run per (action, id), with the per-action sets independent.
    let first =
        TaskLease::acquire(commit_in_flight(), "task-x").expect("first acquire holds the task");
    assert!(
        TaskLease::acquire(commit_in_flight(), "task-x").is_none(),
        "a second concurrent commit on the same task is refused"
    );
    assert!(
        TaskLease::acquire(commit_in_flight(), "task-y").is_some(),
        "a different task is unaffected"
    );
    assert!(
        TaskLease::acquire(merge_in_flight(), "task-x").is_some(),
        "a different action (merge) on the same task is independent"
    );

    drop(first);
    assert!(
        TaskLease::acquire(commit_in_flight(), "task-x").is_some(),
        "dropping the lease (incl. on an early `?` return) frees the task"
    );
}

#[test]
fn commit_refused_while_merge_or_finalize_holds_the_task() {
    // The symmetry arm: merge/finalize always refused under a live commit,
    // but a commit that leased FIRST slipped past — it would stage/commit
    // into a worktree the completing merge/finalize force-deletes. Both
    // finalize and the local merge take the MERGE lease, so one probe
    // covers both. Unique id: the sets are global.
    let merge_lease =
        TaskLease::acquire(merge_in_flight(), "commit-vs-merge").expect("merge lease");
    let err =
        refuse_commit_while_merge_in_flight("commit-vs-merge").expect_err("commit is refused");
    assert!(err.contains("merge"), "names the conflicting action: {err}");
    assert!(
        err.contains("committing"),
        "names the refused action: {err}"
    );
    // Other tasks are unaffected, and dropping the lease frees this one.
    assert!(refuse_commit_while_merge_in_flight("commit-vs-merge-other").is_ok());
    drop(merge_lease);
    assert!(refuse_commit_while_merge_in_flight("commit-vs-merge").is_ok());
}

#[test]
fn merge_refused_while_pr_creation_holds_the_task() {
    // The cross-action direction: a merge must refuse while a PR creation
    // holds the task (its cleanup would delete the worktree/branch under
    // the in-flight push/`gh pr create`). Unique id: the sets are global.
    let pr_lease =
        TaskLease::acquire(crate::workflow::pr::pr_in_flight(), "merge-vs-pr").expect("pr lease");
    let err = refuse_while_pr_in_flight("merge-vs-pr").expect_err("merge is refused");
    assert!(err.contains("PR"), "names the conflicting action: {err}");
    assert!(err.contains("merging"), "names the refused action: {err}");
    // Other tasks are unaffected, and dropping the lease frees this one.
    assert!(refuse_while_pr_in_flight("merge-vs-pr-other").is_ok());
    drop(pr_lease);
    assert!(refuse_while_pr_in_flight("merge-vs-pr").is_ok());
}
