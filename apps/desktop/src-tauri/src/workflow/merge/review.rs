//! Verification-approval resolution (M4 §D): the commands that resolve a task
//! parked in `WaitingApproval` (accept / reject the reviewer's verdict) and the
//! `rerun_verification` re-dispatch. Distinct from the *plan* approval in
//! `plan_approval.rs`: a verification-parked task has NO live session, so those
//! permission-resolving commands don't apply here.

use tauri::{AppHandle, Emitter, State};

use super::commit::require_project;
use crate::store::TaskStore;
use crate::task::{Task, TaskStatus, TASK_EVENT};

/// Guard a review-approval action against a racing `rerun_verification`. Accept/reject
/// are bare state writes with no slot awareness, but `rerun_verification` leases a slot
/// and moves the task to `Verifying`; if a click on Accept/Reject interleaves with a
/// Rerun, the reviewer's later completion is mis-routed and its slot leaks. Refusing
/// while a slot is held (a rerun is in flight) plus the `WaitingApproval` precondition
/// below (checked atomically inside `mutate_if`) closes the window.
fn ensure_review_resolvable(
    orch: &crate::orchestration::coordinator::Orchestrator,
    id: &str,
) -> Result<(), String> {
    if orch.slots.is_leased(id) {
        return Err("a verification run is in progress — wait for it to finish".to_string());
    }
    Ok(())
}

/// Require a task to be parked for verification approval. Run as the `mutate_if` check so
/// the status test and the write happen under one lock — a concurrent transition (e.g. a
/// reviewer completion flipping the task to `Verifying`/`Done`) can't slip between them.
fn waiting_approval(t: &Task) -> Result<(), String> {
    if t.status == TaskStatus::WaitingApproval {
        Ok(())
    } else {
        Err(format!(
            "task is not waiting for review approval (status: {:?})",
            t.status
        ))
    }
}

/// Accept the review on the user's authority (override the reviewer): mark the
/// task `verified` and `Done`. The worktree is retained for commit/merge.
#[tauri::command]
pub fn accept_review(
    app: AppHandle,
    store: State<'_, TaskStore>,
    orch: State<'_, crate::orchestration::coordinator::Orchestrator>,
    id: String,
) -> Result<(), String> {
    ensure_review_resolvable(&orch, &id)?;
    let updated = store.mutate_if(&id, waiting_approval, |t| {
        t.verified = true;
        t.status = TaskStatus::Done;
        t.error = None;
    })?;
    let _ = app.emit(TASK_EVENT, &updated);
    Ok(())
}

/// Reject the review: send the task back to `Backlog` (not verified), keeping
/// `task.review` for context so the user sees why it was rejected.
#[tauri::command]
pub fn reject_review(
    app: AppHandle,
    store: State<'_, TaskStore>,
    orch: State<'_, crate::orchestration::coordinator::Orchestrator>,
    id: String,
) -> Result<(), String> {
    ensure_review_resolvable(&orch, &id)?;
    let updated = store.mutate_if(&id, waiting_approval, |t| {
        t.verified = false;
        t.status = TaskStatus::Backlog;
    })?;
    let _ = app.emit(TASK_EVENT, &updated);
    Ok(())
}

/// Re-run verification against the current worktree without rebuilding (M4 §D):
/// move the task back to `Verifying`, lease a slot, and dispatch a fresh reviewer
/// session. Refuses when there is no worktree to diff.
#[tauri::command]
pub async fn rerun_verification(
    app: AppHandle,
    store: State<'_, TaskStore>,
    orch: State<'_, crate::orchestration::coordinator::Orchestrator>,
    id: String,
) -> Result<(), String> {
    let task = store
        .get(&id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let project = require_project(&app)?;
    let project_path = std::path::PathBuf::from(&project.path);
    // Worktree-mode tasks re-review their `nc/<taskId>` worktree (it must still
    // exist on disk); main-mode tasks re-review the project root (working tree vs
    // HEAD) — there is no worktree to require there (M4.6 §A).
    let worktree_dir = if task.run_mode.is_worktree() {
        let dir = crate::worktree::worktree_path(&project_path, &id);
        if !dir.exists() {
            return Err("no worktree to verify — re-run the task instead".to_string());
        }
        dir
    } else {
        project_path
    };

    if !orch.slots.try_lease(&id) {
        return Err("no free slot (max concurrency reached)".to_string());
    }
    if let Err(e) = crate::sidecar::ensure_reader(&app).await {
        orch.slots.release(&id);
        return Err(e);
    }
    if let Ok(updated) = store.mutate(&id, |t| {
        t.status = TaskStatus::Verifying;
        t.verified = false;
        t.error = None;
    }) {
        let _ = app.emit(TASK_EVENT, &updated);
    }
    if let Err(e) = crate::sidecar::dispatch_reviewer_for(&app, &id, &worktree_dir).await {
        orch.slots.release(&id);
        if let Ok(updated) = store.mutate(&id, |t| {
            t.status = TaskStatus::WaitingApproval;
            t.error = Some(format!("could not start reviewer: {e}"));
        }) {
            let _ = app.emit(TASK_EVENT, &updated);
        }
        return Err(e);
    }
    Ok(())
}
