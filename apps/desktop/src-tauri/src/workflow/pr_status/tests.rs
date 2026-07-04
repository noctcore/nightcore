//! Unit + real-git/fake-`gh` tests for the PR-status arc, kept together so the
//! pure classification, precondition, finalize, and pull cases share the
//! `fake_gh` / `temp_repo` / `seed_pr_task` fixtures.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::json;

use super::finalize::{
    finalize_merged_core, refuse_finalize_under_live_session,
    refuse_finalize_while_sibling_in_flight,
};
use super::pull::{pull_base_ff_core, resolve_pull_base};
use super::push::{check_push_preconditions, refuse_push_while_sibling_in_flight};
use super::view::{count_checks, fetch_pr_view_with, require_pr_number, GhPrView, PR_VIEW_FIELDS};
use crate::store::TaskStore;
use crate::task::{RunMode, Task, TaskStatus};
use crate::workflow::merge::{acquire_root_lease, commit_in_flight, merge_in_flight, TaskLease};
use crate::workflow::pr::pr_in_flight;
use crate::worktree;

// ── Pure classification ────────────────────────────────────────────────

#[test]
fn count_checks_classifies_both_rollup_shapes_tolerantly() {
    // The most drift-prone parse in the feature: CheckRun (status +
    // conclusion) and StatusContext (state) entries, mixed, with unknown
    // vocabulary and malformed entries degrading to PENDING — the verdict
    // that never overstates a green or a red.
    let rollup = json!([
        // CheckRun passes.
        {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"},
        {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "NEUTRAL"},
        {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SKIPPED"},
        // CheckRun failures.
        {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "FAILURE"},
        {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "CANCELLED"},
        {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "TIMED_OUT"},
        {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "ACTION_REQUIRED"},
        {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "STARTUP_FAILURE"},
        // CheckRun pendings: not completed (whatever conclusion says),
        // null/absent conclusion, unknown conclusion vocabulary.
        {"__typename": "CheckRun", "status": "IN_PROGRESS", "conclusion": null},
        {"__typename": "CheckRun", "status": "QUEUED"},
        {"__typename": "CheckRun", "status": "WAITING", "conclusion": "SUCCESS"},
        {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": null},
        {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SOME_NEW_VERDICT"},
        // StatusContext: pass / fails / pendings / unknown.
        {"__typename": "StatusContext", "state": "SUCCESS"},
        {"__typename": "StatusContext", "state": "FAILURE"},
        {"__typename": "StatusContext", "state": "ERROR"},
        {"__typename": "StatusContext", "state": "PENDING"},
        {"__typename": "StatusContext", "state": "EXPECTED"},
        {"__typename": "StatusContext", "state": "SOME_NEW_STATE"},
        // Malformed entries degrade to pending, never a crash.
        {},
        "not an object",
    ]);
    assert_eq!(count_checks(Some(&rollup)), (4, 7, 10));
}

#[test]
fn count_checks_is_case_insensitive_against_casing_drift() {
    let rollup = json!([
        {"status": "completed", "conclusion": "success"},
        {"state": "failure"},
    ]);
    assert_eq!(count_checks(Some(&rollup)), (1, 1, 0));
}

#[test]
fn count_checks_treats_missing_null_or_nonarray_rollup_as_zero() {
    // A PR with no checks: gh emits null or omits the field entirely.
    assert_eq!(count_checks(None), (0, 0, 0));
    assert_eq!(count_checks(Some(&json!(null))), (0, 0, 0));
    assert_eq!(count_checks(Some(&json!([]))), (0, 0, 0));
    // A non-array shape (future drift) degrades to zeros, never a crash.
    assert_eq!(count_checks(Some(&json!({"weird": true}))), (0, 0, 0));
    assert_eq!(count_checks(Some(&json!("weird"))), (0, 0, 0));
}

#[test]
fn gh_view_deserializes_minimal_and_null_padded_payloads() {
    // Only the identifying trio is required; every other field may be
    // absent OR null across gh versions and degrades to a safe default.
    let minimal: GhPrView =
        serde_json::from_str(r#"{"number":7,"url":"https://x/pull/7","state":"OPEN"}"#)
            .expect("minimal view parses");
    let status = minimal.into_status(Some(2));
    assert_eq!(status.number, 7);
    assert_eq!(status.state, "OPEN");
    assert!(!status.is_draft);
    assert_eq!(status.mergeable, "");
    assert_eq!(status.merge_state_status, "");
    assert_eq!(status.review_decision, "");
    assert_eq!(status.base_ref_name, "");
    assert_eq!(
        (
            status.checks_passed,
            status.checks_failed,
            status.checks_pending
        ),
        (0, 0, 0)
    );
    assert_eq!(
        status.unpushed_commits,
        Some(2),
        "the local count passes through"
    );

    let padded: GhPrView = serde_json::from_str(
        r#"{"number":8,"url":"https://x/pull/8","state":"MERGED","isDraft":null,
            "mergeable":null,"mergeStateStatus":null,"reviewDecision":null,
            "baseRefName":null,"statusCheckRollup":null}"#,
    )
    .expect("null-padded view parses");
    assert_eq!(padded.into_status(Some(0)).state, "MERGED");
}

#[test]
fn pr_status_serializes_camel_case() {
    // The wire contract the web builds against: camelCase keys, plain
    // strings, no timestamps.
    let status = GhPrView {
        number: 12,
        url: "https://github.com/a/b/pull/12".into(),
        state: "OPEN".into(),
        is_draft: Some(true),
        mergeable: Some("MERGEABLE".into()),
        merge_state_status: Some("CLEAN".into()),
        review_decision: Some("APPROVED".into()),
        base_ref_name: Some("main".into()),
        status_check_rollup: None,
    }
    .into_status(Some(4));
    let json = serde_json::to_string(&status).expect("serialize");
    for key in [
        r#""state":"OPEN""#,
        r#""isDraft":true"#,
        r#""mergeable":"MERGEABLE""#,
        r#""mergeStateStatus":"CLEAN""#,
        r#""reviewDecision":"APPROVED""#,
        r#""checksPassed":0"#,
        r#""checksFailed":0"#,
        r#""checksPending":0"#,
        r#""baseRefName":"main""#,
        r#""number":12"#,
        r#""unpushedCommits":4"#,
    ] {
        assert!(json.contains(key), "wire shape carries {key}: {json}");
    }

    // The cannot-determine shape crosses the wire as an explicit null (the
    // web contract is `number | null`), never a fake 0.
    let unknown = GhPrView {
        number: 13,
        url: "https://github.com/a/b/pull/13".into(),
        state: "OPEN".into(),
        is_draft: None,
        mergeable: None,
        merge_state_status: None,
        review_decision: None,
        base_ref_name: None,
        status_check_rollup: None,
    }
    .into_status(None);
    let json = serde_json::to_string(&unknown).expect("serialize");
    assert!(
        json.contains(r#""unpushedCommits":null"#),
        "unknown count serializes as null: {json}"
    );
}

// ── Preconditions + lease cross-checks ─────────────────────────────────

#[test]
fn require_pr_number_refuses_a_task_without_one() {
    let task = Task::new("t".into(), String::new());
    let err = require_pr_number(&task).expect_err("no PR number is refused");
    assert!(err.contains("no PR"), "explains the refusal: {err}");

    let mut with = Task::new("t".into(), String::new());
    with.pr_number = Some(7);
    assert_eq!(require_pr_number(&with), Ok(7));
}

#[test]
fn push_preconditions_require_an_existing_pr() {
    let task = Task::new("t".into(), String::new()).with_run_mode(RunMode::Worktree);
    let err = check_push_preconditions(&task).expect_err("no PR is refused");
    assert!(err.contains("no PR"), "explains the refusal: {err}");

    let mut with = task.clone();
    with.pr_url = Some("https://github.com/a/b/pull/7".into());
    assert!(check_push_preconditions(&with).is_ok());
}

#[test]
fn push_updates_refused_while_merge_or_commit_holds_the_task() {
    // Merge direction: a completing merge deletes the worktree/branch out
    // from under an in-flight push. Unique ids: the sets are global.
    let merge_lease = TaskLease::acquire(merge_in_flight(), "push-vs-merge").expect("merge lease");
    let err = refuse_push_while_sibling_in_flight("push-vs-merge").expect_err("push is refused");
    assert!(err.contains("merge"), "names the conflicting action: {err}");
    drop(merge_lease);
    assert!(refuse_push_while_sibling_in_flight("push-vs-merge").is_ok());

    // Commit direction: the push would race the in-progress stage/commit.
    let commit_lease =
        TaskLease::acquire(commit_in_flight(), "push-vs-commit").expect("commit lease");
    let err = refuse_push_while_sibling_in_flight("push-vs-commit").expect_err("push is refused");
    assert!(
        err.contains("commit"),
        "names the conflicting action: {err}"
    );
    // Other tasks are unaffected, and dropping the lease frees this one.
    assert!(refuse_push_while_sibling_in_flight("push-vs-commit-other").is_ok());
    drop(commit_lease);
    assert!(refuse_push_while_sibling_in_flight("push-vs-commit").is_ok());
}

#[test]
fn finalize_refused_while_pr_or_commit_holds_the_task() {
    // PR direction: finalize's cleanup would delete the worktree under an
    // in-flight push/create.
    let pr_lease = TaskLease::acquire(pr_in_flight(), "fin-vs-pr").expect("pr lease");
    let err =
        refuse_finalize_while_sibling_in_flight("fin-vs-pr").expect_err("finalize is refused");
    assert!(err.contains("PR"), "names the conflicting action: {err}");
    drop(pr_lease);
    assert!(refuse_finalize_while_sibling_in_flight("fin-vs-pr").is_ok());

    // Commit direction.
    let commit_lease =
        TaskLease::acquire(commit_in_flight(), "fin-vs-commit").expect("commit lease");
    let err =
        refuse_finalize_while_sibling_in_flight("fin-vs-commit").expect_err("finalize is refused");
    assert!(
        err.contains("commit"),
        "names the conflicting action: {err}"
    );
    drop(commit_lease);
    assert!(refuse_finalize_while_sibling_in_flight("fin-vs-commit").is_ok());
}

#[test]
fn finalize_refused_under_a_live_session() {
    // Slot arm: a leased orchestrator slot (running/dispatching session)
    // refuses regardless of status — finalize's cleanup would force-delete
    // the worktree that session is cwd'd into.
    for status in [
        TaskStatus::Backlog,
        TaskStatus::Done,
        TaskStatus::WaitingApproval,
    ] {
        let err = refuse_finalize_under_live_session(true, status)
            .expect_err("a leased slot refuses finalize");
        assert!(err.contains("session"), "explains the refusal: {err}");
    }
    // Status arm: InProgress/Verifying refuse even when the slot probe
    // reads free (the dispatch window — e.g. rerun_verification just moved
    // the task to Verifying).
    for status in [TaskStatus::InProgress, TaskStatus::Verifying] {
        let err = refuse_finalize_under_live_session(false, status)
            .expect_err("a live status refuses finalize");
        assert!(err.contains("session"), "explains the refusal: {err}");
    }
    // No slot + settled statuses pass.
    for status in [
        TaskStatus::Backlog,
        TaskStatus::Ready,
        TaskStatus::WaitingApproval,
        TaskStatus::Done,
        TaskStatus::Failed,
    ] {
        assert!(refuse_finalize_under_live_session(false, status).is_ok());
    }
}

#[test]
fn pull_is_single_flight_per_project_root_and_cross_refused() {
    // The pull's guard is the ROOT lease keyed per project path — the same
    // lease merge_task's merge phase and the main-mode commit take — so all
    // three root mutators serialize on one project and different projects
    // are independent. Unique paths: the set is global.
    let root_a = Path::new("/tmp/nc-root-serialization-a");
    let root_b = Path::new("/tmp/nc-root-serialization-b");

    // Simulate a merge holding root A: a pull on root A refuses (either
    // direction — the lease is symmetric), root B is unaffected.
    let merge_holds = acquire_root_lease(root_a, "merging")
        .unwrap_or_else(|e| panic!("merge leases root A: {e}"));
    let err = acquire_root_lease(root_a, "pulling the base")
        .err()
        .expect("a pull on the same root is refused");
    assert!(
        err.contains("modifying the project root") && err.contains("pulling the base"),
        "explains the refusal and names the blocked action: {err}"
    );
    assert!(
        acquire_root_lease(root_b, "pulling the base").is_ok(),
        "a different project root is unaffected"
    );
    drop(merge_holds);

    // With the root free, a pull leases it and blocks a merge and a commit
    // — the cross-refusal arms of the shared guard.
    let pull_holds = acquire_root_lease(root_a, "pulling the base")
        .unwrap_or_else(|e| panic!("pull leases root A: {e}"));
    let err = acquire_root_lease(root_a, "merging")
        .err()
        .expect("merge refused under a pull");
    assert!(err.contains("merging"), "names the blocked action: {err}");
    let err = acquire_root_lease(root_a, "committing")
        .err()
        .expect("commit refused under a pull");
    assert!(
        err.contains("committing"),
        "names the blocked action: {err}"
    );
    drop(pull_holds);
    assert!(
        acquire_root_lease(root_a, "merging").is_ok(),
        "dropping the lease frees the root"
    );
}

// ── Fixtures (the phase-1 fake-gh + temp-repo patterns) ────────────────

/// Write an executable shell script into `dir` to stand in for `gh`, so
/// the tests exercise the real spawn + exit-code mapping (not a mock).
#[cfg(unix)]
fn fake_gh(dir: &Path, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("fake-gh.sh");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write script");
    let mut perms = std::fs::metadata(&path)
        .expect("script metadata")
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).expect("chmod script");
    path
}

/// A one-line fake-gh body that prints a `gh pr view`-shaped payload for
/// PR `number` in `state`.
#[cfg(unix)]
fn view_json(number: u64, state: &str) -> String {
    format!(
        "echo '{{\"number\":{number},\"url\":\"https://github.com/acme/widget/pull/{number}\",\
         \"state\":\"{state}\",\"isDraft\":false,\"mergeable\":\"UNKNOWN\",\
         \"mergeStateStatus\":\"UNKNOWN\",\"reviewDecision\":\"\",\"baseRefName\":\"main\",\
         \"statusCheckRollup\":[]}}'"
    )
}

/// Build a real git repo with one commit (the worktree-tests fixture).
/// `None` (skipping the test) when `git` is unavailable.
fn temp_repo() -> Option<(tempfile::TempDir, PathBuf)> {
    let tmp = tempfile::TempDir::new().ok()?;
    let path = tmp.path().to_path_buf();
    if !run_in(&path, &["init", "-q"]) {
        return None;
    }
    run_in(&path, &["config", "user.email", "t@t.t"]);
    run_in(&path, &["config", "user.name", "t"]);
    std::fs::write(path.join(".gitignore"), ".nightcore/\n").ok()?;
    std::fs::write(path.join("README.md"), "hi").ok()?;
    run_in(&path, &["add", "."]);
    if !run_in(&path, &["commit", "-q", "-m", "init"]) {
        return None;
    }
    Some((tmp, path))
}

/// Run a git command in `dir` for tests, returning success.
fn run_in(dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// A bare repo standing in for `origin`, wired into `repo` — so pushes and
/// fetches need no network.
fn add_bare_origin(repo: &Path) -> Option<tempfile::TempDir> {
    let bare = tempfile::TempDir::new().ok()?;
    let ok = Command::new("git")
        .args(["init", "-q", "--bare"])
        .current_dir(bare.path())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ok || !run_in(repo, &["remote", "add", "origin", bare.path().to_str()?]) {
        return None;
    }
    Some(bare)
}

/// A store rooted at a fresh temp dir + a seeded worktree-mode task that
/// carries a PR (the finalize fixture).
fn seed_pr_task(pr_number: u64) -> (TaskStore, tempfile::TempDir, String) {
    let tmp = tempfile::TempDir::new().expect("store dir");
    let store = TaskStore::load_from(tmp.path().join("tasks"));
    let mut task = Task::new("Add login".into(), "OAuth".into()).with_run_mode(RunMode::Worktree);
    task.committed = true;
    task.verified = true;
    task.pr_url = Some(format!("https://github.com/acme/widget/pull/{pr_number}"));
    task.pr_number = Some(pr_number);
    let id = task.id.clone();
    store.upsert(&task).expect("seed task");
    (store, tmp, id)
}

// ── fetch_pr_view_with (the bounded gh seam) ───────────────────────────

#[test]
#[cfg(unix)]
fn fetch_pr_view_parses_a_success_and_carries_the_contract_argv() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let body = "printf '%s\\n' \"$@\" > args.txt\n\
         echo '{\"number\":42,\"url\":\"https://github.com/acme/widget/pull/42\",\
         \"state\":\"OPEN\",\"isDraft\":true,\"mergeable\":\"MERGEABLE\",\
         \"mergeStateStatus\":\"BLOCKED\",\"reviewDecision\":\"REVIEW_REQUIRED\",\
         \"baseRefName\":\"develop\",\"statusCheckRollup\":[\
         {\"status\":\"COMPLETED\",\"conclusion\":\"SUCCESS\"},\
         {\"state\":\"FAILURE\"},\
         {\"status\":\"IN_PROGRESS\"}]}'";
    let script = fake_gh(tmp.path(), body);
    let view = fetch_pr_view_with(
        tmp.path(),
        script.to_str().expect("utf8 path"),
        42,
        Duration::from_secs(10),
    )
    .expect("view parses");
    let status = view.into_status(Some(5));
    assert_eq!(status.number, 42);
    assert_eq!(status.state, "OPEN");
    assert!(status.is_draft);
    assert_eq!(status.mergeable, "MERGEABLE");
    assert_eq!(status.merge_state_status, "BLOCKED");
    assert_eq!(status.review_decision, "REVIEW_REQUIRED");
    assert_eq!(status.base_ref_name, "develop");
    assert_eq!(
        (
            status.checks_passed,
            status.checks_failed,
            status.checks_pending
        ),
        (1, 1, 1),
        "the rollup was counted Rust-side"
    );
    assert_eq!(status.unpushed_commits, Some(5));

    // The argv carries the contract: `pr view <n> --json <field list>`.
    let args = std::fs::read_to_string(tmp.path().join("args.txt")).expect("args.txt");
    let args: Vec<&str> = args.lines().collect();
    for expected in ["pr", "view", "42", "--json", PR_VIEW_FIELDS] {
        assert!(
            args.contains(&expected),
            "argv missing {expected}: {args:?}"
        );
    }
}

#[test]
#[cfg(unix)]
fn fetch_pr_view_surfaces_stderr_verbatim_on_failure() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let script = fake_gh(
        tmp.path(),
        "echo 'no pull requests found for branch \"nc/t-1\"' >&2\nexit 1",
    );
    let err = fetch_pr_view_with(
        tmp.path(),
        script.to_str().expect("utf8 path"),
        42,
        Duration::from_secs(10),
    )
    .expect_err("a non-zero exit maps to Err");
    assert!(
        err.contains("no pull requests found"),
        "gh's stderr is verbatim: {err}"
    );
}

#[test]
#[cfg(unix)]
fn fetch_pr_view_reports_malformed_json_loudly() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let script = fake_gh(tmp.path(), "echo 'this is not json'");
    let err = fetch_pr_view_with(
        tmp.path(),
        script.to_str().expect("utf8 path"),
        42,
        Duration::from_secs(10),
    )
    .expect_err("garbage output maps to Err");
    assert!(err.contains("unparseable JSON"), "names the failure: {err}");
}

#[test]
#[cfg(unix)]
fn fetch_pr_view_times_out_a_hung_gh() {
    // A black-holed GitHub must error out under the deadline, not pin the
    // blocking thread. The deadline is injectable, so the test stays fast.
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let script = fake_gh(tmp.path(), "sleep 30");
    let start = std::time::Instant::now();
    let err = fetch_pr_view_with(
        tmp.path(),
        script.to_str().expect("utf8 path"),
        42,
        Duration::from_millis(200),
    )
    .expect_err("an overrunning gh times out");
    assert!(err.contains("timed out"), "names the timeout: {err}");
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "the kill returns promptly, not after the child's sleep"
    );
}

#[test]
fn fetch_pr_view_reports_a_missing_gh_as_install_guidance() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let err = fetch_pr_view_with(
        tmp.path(),
        "definitely-not-a-real-binary-xyz",
        42,
        Duration::from_secs(1),
    )
    .expect_err("a missing gh is refused");
    assert!(
        err.contains("not installed"),
        "points at the install: {err}"
    );
}

// ── finalize_merged_core (temp repo + bare origin + fake gh) ───────────

#[test]
#[cfg(unix)]
fn finalize_marks_merged_and_cleans_up_when_the_setting_is_on() {
    let Some((_tmp, repo)) = temp_repo() else {
        return; // git unavailable
    };
    let Some(_bare) = add_bare_origin(&repo) else {
        return;
    };
    let (store, _store_tmp, id) = seed_pr_task(7);
    let dir = worktree::allocate(&repo, &id).expect("allocate");
    std::fs::write(dir.join("f.txt"), "x").expect("write");
    worktree::commit(&repo, &id, "work").expect("commit");
    let branch = worktree::branch_name(&id);
    worktree::push_branch(&dir, &branch).expect("push");

    // The fake gh lives OUTSIDE the repo so it never dirties the worktree.
    let script_dir = tempfile::TempDir::new().expect("script dir");
    let script = fake_gh(script_dir.path(), &view_json(7, "MERGED"));

    let updated = finalize_merged_core(&store, &repo, &id, script.to_str().unwrap(), true)
        .expect("finalize succeeds");
    assert!(updated.merged, "the returned task is merged");
    assert!(!updated.conflict);
    assert!(
        store.get(&id).expect("task").merged,
        "the merged flag is PERSISTED via the store, not just returned"
    );
    assert!(!dir.exists(), "cleanup=on removed the worktree");
    assert!(
        !run_in(
            &repo,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                &branch
            ],
        ),
        "cleanup=on deleted the branch"
    );
}

#[test]
#[cfg(unix)]
fn finalize_keeps_the_worktree_when_cleanup_is_off() {
    // Exact parity with the local merge: cleanup_worktrees=false keeps the
    // worktree + branch for inspection until merge/discard.
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    let Some(_bare) = add_bare_origin(&repo) else {
        return;
    };
    let (store, _store_tmp, id) = seed_pr_task(7);
    let dir = worktree::allocate(&repo, &id).expect("allocate");
    std::fs::write(dir.join("f.txt"), "x").expect("write");
    worktree::commit(&repo, &id, "work").expect("commit");
    let branch = worktree::branch_name(&id);
    worktree::push_branch(&dir, &branch).expect("push");

    let script_dir = tempfile::TempDir::new().expect("script dir");
    let script = fake_gh(script_dir.path(), &view_json(7, "MERGED"));

    let updated = finalize_merged_core(&store, &repo, &id, script.to_str().unwrap(), false)
        .expect("finalize succeeds");
    assert!(updated.merged);
    assert!(dir.exists(), "cleanup=off keeps the worktree");
    assert!(
        run_in(
            &repo,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                &branch
            ],
        ),
        "cleanup=off keeps the branch"
    );
}

#[test]
#[cfg(unix)]
fn finalize_refuses_a_pr_that_is_not_merged_on_github() {
    // The server-side verification: the caller's claim is never trusted —
    // an OPEN PR refuses, and nothing local changes.
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    let Some(_bare) = add_bare_origin(&repo) else {
        return;
    };
    let (store, _store_tmp, id) = seed_pr_task(7);
    let dir = worktree::allocate(&repo, &id).expect("allocate");
    std::fs::write(dir.join("f.txt"), "x").expect("write");
    worktree::commit(&repo, &id, "work").expect("commit");
    worktree::push_branch(&dir, &worktree::branch_name(&id)).expect("push");

    let script_dir = tempfile::TempDir::new().expect("script dir");
    let script = fake_gh(script_dir.path(), &view_json(7, "OPEN"));

    let err = finalize_merged_core(&store, &repo, &id, script.to_str().unwrap(), true)
        .expect_err("an OPEN PR must refuse to finalize");
    assert!(err.contains("not merged"), "explains the refusal: {err}");
    assert!(err.contains("OPEN"), "names the actual state: {err}");
    assert!(!store.get(&id).expect("task").merged, "task untouched");
    assert!(dir.exists(), "the worktree was not cleaned up");
}

#[test]
#[cfg(unix)]
fn finalize_refuses_when_unpushed_local_commits_would_be_destroyed() {
    // worktree::remove is `--force`: a local commit that never reached the
    // remote would be silently destroyed by cleanup. Refuse it, even when
    // GitHub says MERGED.
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    let Some(_bare) = add_bare_origin(&repo) else {
        return;
    };
    let (store, _store_tmp, id) = seed_pr_task(7);
    let dir = worktree::allocate(&repo, &id).expect("allocate");
    std::fs::write(dir.join("f.txt"), "x").expect("write");
    worktree::commit(&repo, &id, "work").expect("commit");
    worktree::push_branch(&dir, &worktree::branch_name(&id)).expect("push");
    // A second commit that is NOT pushed.
    std::fs::write(dir.join("late-fix.txt"), "y").expect("write");
    worktree::commit(&repo, &id, "late fix").expect("commit 2");

    let script_dir = tempfile::TempDir::new().expect("script dir");
    let script = fake_gh(script_dir.path(), &view_json(7, "MERGED"));

    let err = finalize_merged_core(&store, &repo, &id, script.to_str().unwrap(), true)
        .expect_err("unpushed commits must refuse to finalize");
    assert!(err.contains("unpushed"), "explains the refusal: {err}");
    assert!(dir.exists(), "the worktree (and its commits) survive");
    assert!(!store.get(&id).expect("task").merged, "task untouched");
}

#[test]
#[cfg(unix)]
fn finalize_refuses_when_the_upstream_is_gone_instead_of_failing_open() {
    // THE FAIL-OPEN SCENARIO the old tolerant-zero count enabled: `-u` push,
    // one more local commit never pushed, PR merged on GitHub with
    // auto-delete-head-branches, any prune fetch removes `origin/nc/<id>` —
    // `@{upstream}` no longer resolves, the count read as 0, the refusal was
    // bypassed, and cleanup destroyed the unpushed commit. Now the
    // unresolvable upstream REFUSES.
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    let Some(_bare) = add_bare_origin(&repo) else {
        return;
    };
    let (store, _store_tmp, id) = seed_pr_task(7);
    let dir = worktree::allocate(&repo, &id).expect("allocate");
    std::fs::write(dir.join("f.txt"), "x").expect("write");
    worktree::commit(&repo, &id, "work").expect("commit");
    let branch = worktree::branch_name(&id);
    worktree::push_branch(&dir, &branch).expect("push");
    // The commit that must survive: local-only, never pushed.
    std::fs::write(dir.join("late-fix.txt"), "y").expect("write");
    worktree::commit(&repo, &id, "late fix").expect("commit 2");
    // Prune the remote-tracking ref (what GitHub auto-delete + any prune
    // fetch produces).
    let tracking = format!("refs/remotes/origin/{branch}");
    assert!(
        run_in(&dir, &["update-ref", "-d", &tracking]),
        "prune the remote-tracking ref"
    );

    let script_dir = tempfile::TempDir::new().expect("script dir");
    let script = fake_gh(script_dir.path(), &view_json(7, "MERGED"));

    let err = finalize_merged_core(&store, &repo, &id, script.to_str().unwrap(), true)
        .expect_err("an unresolvable upstream must refuse to finalize");
    assert!(err.contains("cannot verify"), "explains the refusal: {err}");
    assert!(
        dir.exists() && dir.join("late-fix.txt").exists(),
        "the worktree and its unpushed commit survive"
    );
    assert!(!store.get(&id).expect("task").merged, "task untouched");
}

#[test]
fn finalize_refuses_without_a_pr_number_and_when_already_merged() {
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    // No PR recorded.
    let tmp = tempfile::TempDir::new().expect("store dir");
    let store = TaskStore::load_from(tmp.path().join("tasks"));
    let task = Task::new("t".into(), String::new()).with_run_mode(RunMode::Worktree);
    let id = task.id.clone();
    store.upsert(&task).expect("seed");
    let err = finalize_merged_core(&store, &repo, &id, "gh-unused", true)
        .expect_err("no PR number is refused");
    assert!(err.contains("no PR"), "explains the refusal: {err}");

    // Already merged: nothing to finalize (and no gh spawn happens — the
    // binary name is deliberately bogus).
    let (store, _store_tmp, id) = seed_pr_task(7);
    store.mutate(&id, |t| t.merged = true).expect("mark merged");
    let err = finalize_merged_core(&store, &repo, &id, "gh-unused", true)
        .expect_err("already merged is refused");
    assert!(err.contains("already merged"), "explains: {err}");
}

// ── pull_base_ff_core (real temp repo pair) ────────────────────────────

#[test]
fn pull_base_ff_fast_forwards_then_refuses_a_diverged_base() {
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    let Some(_bare) = add_bare_origin(&repo) else {
        return;
    };
    let base = worktree::current_branch(&repo).expect("a named branch");
    worktree::push_branch(&repo, &base).expect("push base");

    // Advance origin one commit past the local base: commit + push, then
    // rewind the local branch (the remote-tracking ref stays ahead).
    std::fs::write(repo.join("second.txt"), "2").expect("write");
    run_in(&repo, &["add", "."]);
    assert!(run_in(&repo, &["commit", "-q", "-m", "second"]));
    worktree::push_branch(&repo, &base).expect("push second");
    assert!(run_in(&repo, &["reset", "--hard", "-q", "HEAD~1"]));
    assert!(!repo.join("second.txt").exists(), "local base rewound");

    pull_base_ff_core(&repo, &base).expect("a clean fast-forward succeeds");
    assert!(
        repo.join("second.txt").exists(),
        "the base fast-forwarded to origin"
    );

    // Diverge: rewind again and commit DIFFERENT content locally. ff-only
    // must fail (git's error verbatim) and never fall back to a real merge.
    assert!(run_in(&repo, &["reset", "--hard", "-q", "HEAD~1"]));
    std::fs::write(repo.join("local.txt"), "l").expect("write");
    run_in(&repo, &["add", "."]);
    assert!(run_in(&repo, &["commit", "-q", "-m", "diverge"]));
    let err = pull_base_ff_core(&repo, &base).expect_err("a diverged base must not ff");
    assert!(!err.is_empty(), "git's ff-only failure surfaces");
    assert!(
        repo.join("local.txt").exists() && !repo.join("second.txt").exists(),
        "no merge happened — the local branch is untouched"
    );
    assert!(
        worktree::is_worktree_clean(&repo).expect("status"),
        "the failed ff leaves a clean tree (no mid-merge state)"
    );
}

#[test]
fn pull_base_ff_is_not_shadowed_by_a_hostile_local_origin_branch() {
    // Name-precedence attack: a LOCAL branch literally named `origin/<base>`
    // (a plain `git branch "origin/main" <sha>` any in-repo agent can run)
    // shadows the `origin/<base>` shorthand. The ff-merge must use the
    // fully-qualified remote-tracking ref and land on the TRUE remote
    // commit, never the planted one.
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    let Some(_bare) = add_bare_origin(&repo) else {
        return;
    };
    let base = worktree::current_branch(&repo).expect("a named branch");
    worktree::push_branch(&repo, &base).expect("push base");

    // Advance origin one commit past the local base (commit + push + rewind).
    std::fs::write(repo.join("second.txt"), "2").expect("write");
    run_in(&repo, &["add", "."]);
    assert!(run_in(&repo, &["commit", "-q", "-m", "second"]));
    worktree::push_branch(&repo, &base).expect("push second");
    assert!(run_in(&repo, &["reset", "--hard", "-q", "HEAD~1"]));

    // Plant the hostile shadow: a local branch named `origin/<base>` at a
    // DIFFERENT descendant of the rewound base, so a shorthand ff would
    // silently land on it.
    assert!(run_in(&repo, &["checkout", "-q", "-b", "tmp-hostile"]));
    std::fs::write(repo.join("hostile.txt"), "h").expect("write");
    run_in(&repo, &["add", "."]);
    assert!(run_in(&repo, &["commit", "-q", "-m", "hostile"]));
    let shadow = format!("origin/{base}");
    assert!(run_in(&repo, &["branch", &shadow]), "plant shadow branch");
    assert!(run_in(&repo, &["checkout", "-q", &base]));
    assert!(run_in(&repo, &["branch", "-D", "tmp-hostile"]));

    pull_base_ff_core(&repo, &base).expect("the fast-forward succeeds");
    assert!(
        repo.join("second.txt").exists(),
        "the base fast-forwarded to the TRUE remote-tracking commit"
    );
    assert!(
        !repo.join("hostile.txt").exists(),
        "the planted local `origin/<base>` branch was NOT merged"
    );
}

#[test]
fn pull_base_ff_refuses_a_dirty_root() {
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    let base = worktree::current_branch(&repo).expect("a named branch");
    std::fs::write(repo.join("README.md"), "dirty edit").expect("write");
    let err = pull_base_ff_core(&repo, &base).expect_err("a dirty root is refused");
    assert!(
        err.contains("uncommitted changes"),
        "explains the refusal: {err}"
    );
}

#[test]
fn pull_base_ff_refuses_when_the_root_is_not_on_the_base() {
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    let base = worktree::current_branch(&repo).expect("a named branch");
    assert!(run_in(
        &repo,
        &["checkout", "-q", "-b", "feature/elsewhere"]
    ));
    let err = pull_base_ff_core(&repo, &base).expect_err("a wrong branch is refused");
    assert!(
        err.contains("feature/elsewhere") && err.contains(&base),
        "names both branches: {err}"
    );

    // Detached HEAD refuses too (never guess the branch).
    assert!(run_in(&repo, &["checkout", "-q", "--detach"]));
    let err = pull_base_ff_core(&repo, &base).expect_err("detached HEAD is refused");
    assert!(err.contains("detached"), "explains the refusal: {err}");
}

#[test]
fn resolve_pull_base_prefers_the_persisted_base_and_never_fetches_for_it() {
    // A task with a persisted base (written at PR creation) resolves to it
    // without touching gh — the injected fetch proves it by failing loudly.
    let mut task = Task::new("t".into(), String::new()).with_run_mode(RunMode::Worktree);
    task.base_branch = Some("develop".into());
    let base = resolve_pull_base(&task, || panic!("must not fetch when the base is stored"));
    assert_eq!(base.as_deref(), Ok("develop"));
}

#[test]
fn resolve_pull_base_falls_back_to_the_server_base_for_legacy_tasks() {
    // A legacy task (no persisted base) resolves through the gh-reported
    // baseRefName — the server truth, never the root's current branch.
    let task = Task::new("t".into(), String::new()).with_run_mode(RunMode::Worktree);
    let base = resolve_pull_base(&task, || Ok("release/2.0".into()));
    assert_eq!(base.as_deref(), Ok("release/2.0"));

    // The fetch failure surfaces (no silent guess).
    let err = resolve_pull_base(&task, || Err("gh: network down".into()))
        .expect_err("a failed fetch refuses");
    assert!(err.contains("network down"), "surfaces the cause: {err}");

    // An empty server answer refuses rather than guessing.
    let err =
        resolve_pull_base(&task, || Ok("  ".into())).expect_err("an empty baseRefName refuses");
    assert!(
        err.contains("could not determine"),
        "explains the refusal: {err}"
    );

    // The server-reported name is REMOTE-controlled input headed for a git
    // argv: option-injection shapes are rejected by validate_ref.
    let err = resolve_pull_base(&task, || Ok("--force".into()))
        .expect_err("a hostile server base is rejected");
    assert!(
        err.contains("invalid branch/base name"),
        "validate_ref rejection: {err}"
    );
}

#[test]
fn pull_base_ff_rejects_injection_bases_before_any_git_spawn() {
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    for bad in ["--force", "-D", "a..b"] {
        let err = pull_base_ff_core(&repo, bad).expect_err("a hostile base is rejected");
        assert!(
            err.contains("invalid branch/base name"),
            "validate_ref rejection: {err}"
        );
    }
}
