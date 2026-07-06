//! [`push_pr_updates`] — re-push the task branch (plain push, never `--force`) so
//! review-round fixes reach the open PR. Takes the shared PR-arc lease and the
//! same cross-action refusals as merge/commit/PR creation.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::git::validate_ref;
use crate::store::TaskStore;
use crate::task::Task;
use crate::workflow::merge::{
    commit_in_flight, lease_held, merge_in_flight, require_project, TaskLease,
};
use crate::workflow::pr::pr_in_flight;
use crate::worktree;

/// The push-updates precondition: the task must already carry a PR (the create
/// path is the only minter of `pr_url`, so this also implies worktree mode).
/// Pure.
pub(super) fn check_push_preconditions(task: &Task) -> Result<(), String> {
    if task.pr_url.is_none() {
        return Err("no PR is recorded for this task — create one first".to_string());
    }
    Ok(())
}

/// Refuse a PR-lease action (push updates) while a sibling terminal action
/// (merge / commit) holds the task — the same cross-action discipline as PR
/// creation, checked AFTER the PR lease is acquired so whichever action leases
/// second reliably sees the other's lease.
pub(super) fn refuse_push_while_sibling_in_flight(id: &str) -> Result<(), String> {
    if lease_held(merge_in_flight(), id) {
        return Err(
            "a merge for this task is in progress — wait for it to finish before pushing updates"
                .to_string(),
        );
    }
    if lease_held(commit_in_flight(), id) {
        return Err(
            "a commit for this task is in progress — wait for it to finish before pushing updates"
                .to_string(),
        );
    }
    Ok(())
}

/// Re-push the task's branch to `origin` so an open PR picks up new local
/// commits. Plain push, NEVER `--force` (the phase-1 push, re-exposed) — and
/// void: the UI refetches [`super::pr_status`] afterwards for the fresh truth.
#[tauri::command]
pub async fn push_pr_updates(app: AppHandle, id: String) -> Result<(), String> {
    // The push talks to the network (up to 120s) — blocking-pool work.
    tauri::async_runtime::spawn_blocking(move || push_pr_updates_blocking(&app, &id))
        .await
        .map_err(|e| format!("push PR updates failed to run: {e}"))?
}

/// The blocking body of `push_pr_updates`: lease → cross-checks → preconditions
/// → bounded push.
fn push_pr_updates_blocking(app: &AppHandle, id: &str) -> Result<(), String> {
    // Same single-flight set as PR creation: one PR-arc push/create per task at
    // a time, and merges refuse while it is held (`refuse_while_pr_in_flight`).
    let _lease = TaskLease::acquire(pr_in_flight(), id)
        .ok_or_else(|| "a PR action for this task is already in progress".to_string())?;
    refuse_push_while_sibling_in_flight(id)?;
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    // Fix-arc cross-guards. (1) Never push while a PR-fix session (or its
    // auto-commit) works this task's checkout — the push would race the fix's
    // edits/commit on the same branch. (2) Never push while a fix for this PR
    // sits at its own HUMAN push gate: this plain push would ship the fix's
    // branch commit without the user's explicit approval — push or dismiss the
    // fix from the PR workspace first.
    let fix_registry = app
        .try_state::<crate::workflow::pr_fix::PrFixRegistry>()
        .ok_or_else(|| "pr-fix registry unavailable".to_string())?;
    crate::workflow::pr_fix::refuse_while_fix_running(
        &fix_registry,
        task.pr_number,
        id,
        "pushing updates",
    )?;
    if let Some(pr_number) = task.pr_number {
        crate::workflow::pr_fix::refuse_while_fix_pending_push(&fix_registry, pr_number)?;
    }
    let project = require_project(app)?;
    let project_path = PathBuf::from(&project.path);
    check_push_preconditions(&task)?;
    let worktree_dir = worktree::worktree_path(&project_path, id);
    if !worktree_dir.exists() {
        return Err(format!(
            "no worktree for task {id} — there is nothing local to push"
        ));
    }
    // Resolve the branch exactly like create does (task branch → `nc/<id>`) and
    // validate before it reaches any argv (push_branch re-validates too).
    let branch = task
        .branch
        .clone()
        .unwrap_or_else(|| worktree::branch_name(id));
    validate_ref(&branch)?;
    tracing::info!(target: "nightcore::pr", task_id = %id, branch = %branch, "pushing PR updates to origin");
    // Bounded (120s), plain, idempotent — the phase-1 push seam.
    worktree::push_branch(&worktree_dir, &branch)
}
