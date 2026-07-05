//! Checkout resolution for a pr-fix run: reuse a board task's existing worktree
//! when one tracks the PR, else stand up (or reuse) a MANAGED checkout of the
//! PR's head branch under `<project>/.nightcore/pr-fix/pr-<n>`.
//!
//! Safety posture (the PR-arc rules):
//! - The head branch comes from `gh pr view` (bounded, [`probe_gh`]-probed) and
//!   is [`validate_ref`]-validated before it reaches ANY git argv; every
//!   ref-taking call site adds `--end-of-options`.
//! - Fork (cross-repository) PRs are REFUSED before any git work: their head
//!   branch lives in someone else's repo, so a later plain `git push origin
//!   <branch>` would create an unrelated same-named branch here — never what
//!   the user meant.
//! - Never reset/force: an existing managed dir is reused only when it is
//!   already on the PR branch, a stale local branch is checked out as-is (a
//!   diverged push then fails loudly — the abort-not-force philosophy), and the
//!   remote-tracking ref is addressed by its VERBATIM qualified name
//!   (`refs/remotes/origin/<branch>` — the `origin/<branch>` shorthand is
//!   shadowable by a hostile local branch, see `worktree::merge_ff_only`).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::git::gh::{run_gh_checked, GhCall, GH_BINARY};
use crate::git::run::{git, git_status_success};
use crate::store::TaskStore;
use crate::task::TaskStatus;
use crate::worktree::{self, validate_ref};

/// Wall-clock bound on the `gh pr view` head-branch read. A single-object view
/// moves no data, so a black-holed GitHub fails fast (the `GH_VIEW_TIMEOUT`
/// rationale).
const GH_HEAD_TIMEOUT: Duration = Duration::from_secs(60);

/// A reusable task-owned checkout for the PR: the task's worktree dir + branch,
/// plus the task id to lease `pr_in_flight` with (mutual exclusion with that
/// task's own PR actions).
pub(super) struct TaskCheckout {
    pub(super) lease_id: String,
    pub(super) dir: PathBuf,
    pub(super) branch: String,
}

/// Refuse reusing a task's worktree while the task itself has a LIVE SESSION on
/// it: a held orchestrator slot (a build/reviewer session is running or being
/// dispatched) or an `InProgress`/`Verifying` status (the dispatch window where
/// the slot may not be leased yet) — the same live-session probe pair
/// `refuse_finalize_under_live_session` uses. Without it a fix session would
/// launch INTO the worktree the task's own agent is concurrently editing. Pure
/// (the probes are injected booleans), unit-testable.
pub(super) fn refuse_busy_task_checkout(
    slot_leased: bool,
    status: TaskStatus,
) -> Result<(), String> {
    if slot_leased || matches!(status, TaskStatus::InProgress | TaskStatus::Verifying) {
        return Err(
            "the task's own session is using this worktree — wait for it to finish before \
             starting a PR fix"
                .to_string(),
        );
    }
    Ok(())
}

/// Find a board task that tracks `pr_number` and still has its worktree on
/// disk. Branch resolution mirrors `push_pr_updates`: the task's recorded
/// branch, else the default `nc/<taskId>`. ERRS (never falls through to the
/// managed checkout) when the tracking task has a live session on the worktree
/// (`slot_leased` is the orchestrator's `slots.is_leased` probe) — the managed
/// checkout of the same branch would fail anyway (the branch is checked out in
/// the task worktree), so refuse with the clear message instead.
pub(super) fn reusable_task_checkout(
    store: &TaskStore,
    project_path: &Path,
    pr_number: u64,
    slot_leased: impl Fn(&str) -> bool,
) -> Result<Option<TaskCheckout>, String> {
    for task in store.list() {
        if task.pr_number != Some(pr_number) {
            continue;
        }
        let dir = worktree::worktree_path(project_path, &task.id);
        if !dir.exists() {
            continue;
        }
        refuse_busy_task_checkout(slot_leased(&task.id), task.status)?;
        let branch = task
            .branch
            .clone()
            .unwrap_or_else(|| worktree::branch_name(&task.id));
        return Ok(Some(TaskCheckout {
            lease_id: task.id.clone(),
            dir,
            branch,
        }));
    }
    Ok(None)
}

/// The `pr_in_flight` lease id for a managed (task-less) checkout of `pr-<n>`.
/// Disjoint from task ids (uuids), so it can never collide with a task lease.
pub(super) fn managed_lease_id(pr_number: u64) -> String {
    format!("pr-{pr_number}")
}

/// The managed checkout dir for a PR: `<project>/.nightcore/pr-fix/pr-<n>`.
/// A sibling of the task worktrees base (`.nightcore/worktrees/`), kept
/// separate so worktree reconciliation never mistakes it for an orphaned task.
pub(super) fn pr_fix_dir(project_path: &Path, pr_number: u64) -> PathBuf {
    project_path
        .join(".nightcore")
        .join("pr-fix")
        .join(format!("pr-{pr_number}"))
}

/// Resolve a managed checkout for `pr_number`: read the head branch from `gh`
/// (refusing forks), fetch it from origin, and add (or reuse) the
/// `.nightcore/pr-fix/pr-<n>` worktree on that branch. Blocking (`gh` + `git`
/// talk to the network/disk) — the command runs it on the blocking pool.
/// Returns `(dir, branch)`.
pub(super) fn managed_checkout(
    project_path: &Path,
    pr_number: u64,
) -> Result<(PathBuf, String), String> {
    let branch = fetch_pr_refs_with(project_path, GH_BINARY, pr_number, GH_HEAD_TIMEOUT)?.head;
    // Validate at ingestion (defence in depth — every git seam below re-fences
    // with `--end-of-options` too).
    validate_ref(&branch)?;
    // `git fetch origin <branch>` (bounded, ref re-validated inside) so the
    // remote-tracking ref exists/updates before the worktree add reads it.
    worktree::fetch_base(project_path, &branch)?;

    let dir = pr_fix_dir(project_path, pr_number);
    if dir.exists() {
        // Reuse ONLY when the existing checkout is already on the PR branch —
        // never reset/force someone's dir onto a different branch.
        return match worktree::current_branch(&dir) {
            Some(current) if current == branch => Ok((dir, branch)),
            Some(current) => Err(format!(
                "the pr-fix checkout {} already exists but is on branch `{current}`, not \
                 `{branch}` — remove it manually and retry",
                dir.display()
            )),
            None => Err(format!(
                "the pr-fix checkout {} already exists but its branch can't be resolved — \
                 remove it manually and retry",
                dir.display()
            )),
        };
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create the pr-fix base dir: {e}"))?;
    }
    add_branch_worktree(project_path, &dir, &branch)?;
    Ok((dir, branch))
}

/// `git worktree add` the PR branch into `dir`. An existing LOCAL branch is
/// checked out as-is (git itself refuses when it is already checked out
/// elsewhere — e.g. in the main tree — and that error surfaces verbatim);
/// otherwise a local branch is created tracking the just-fetched
/// remote-tracking ref, addressed by its verbatim qualified name so a hostile
/// local `origin/<branch>` ref can't shadow it.
fn add_branch_worktree(project_path: &Path, dir: &Path, branch: &str) -> Result<(), String> {
    let dir_str = dir.to_string_lossy().to_string();
    let local_ref = format!("refs/heads/{branch}");
    let local_exists = git_status_success(
        project_path,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &local_ref,
        ],
    );
    let remote_ref = format!("refs/remotes/origin/{branch}");
    let args: Vec<&str> = if local_exists {
        vec!["worktree", "add", &dir_str, "--end-of-options", branch]
    } else {
        // `-b <branch>` consumes the name as the flag's argument;
        // `--end-of-options` fences the trailing commit-ish positional.
        vec![
            "worktree",
            "add",
            "--track",
            "-b",
            branch,
            &dir_str,
            "--end-of-options",
            &remote_ref,
        ]
    };
    git(project_path, &args).map(|_| ())
}

/// The PR's branch endpoints, read together from one `gh pr view`: the head
/// branch the fix checkout works on, and the base branch the conflicts arc
/// merges from.
#[derive(Debug)]
pub(super) struct PrRefs {
    pub(super) head: String,
    pub(super) base: String,
}

/// Read the PR's head + base branches (+ fork-ness) via bounded `gh pr view`.
/// Binary-parameterized — the fake-`gh` test seam (the PR-arc fixture pattern).
pub(super) fn fetch_pr_refs_with(
    dir: &Path,
    binary: &str,
    pr_number: u64,
    deadline: Duration,
) -> Result<PrRefs, String> {
    let number_arg = pr_number.to_string();
    let stdout = run_gh_checked(GhCall {
        dir,
        binary,
        args: &[
            "pr",
            "view",
            &number_arg,
            "--json",
            "headRefName,baseRefName,isCrossRepository",
        ],
        action: "install it to check out the PR branch",
        subcmd: "pr view",
        stdin: None,
        deadline,
        timeout_msg:
            "timed out reading the pull request from GitHub — check your network and try again",
    })?;
    parse_pr_refs(&stdout)
}

/// Parse the `gh pr view --json headRefName,baseRefName,isCrossRepository`
/// body, REFUSING a fork PR. Fail-closed by shape: every field is required (a
/// body missing `isCrossRepository` is a parse error, never silently "not a
/// fork"). Pure — unit-tested.
pub(super) fn parse_pr_refs(stdout: &str) -> Result<PrRefs, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RefsView {
        head_ref_name: String,
        base_ref_name: String,
        is_cross_repository: bool,
    }
    let view: RefsView = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("`gh pr view` returned unparseable JSON: {e}"))?;
    if view.is_cross_repository {
        return Err(
            "this PR comes from a fork — fork PRs can't be pushed safely from Nightcore; \
             check out the branch manually instead"
                .to_string(),
        );
    }
    let head = view.head_ref_name.trim().to_string();
    if head.is_empty() {
        return Err("`gh pr view` reported an empty head branch".to_string());
    }
    let base = view.base_ref_name.trim().to_string();
    if base.is_empty() {
        return Err("`gh pr view` reported an empty base branch".to_string());
    }
    Ok(PrRefs { head, base })
}
