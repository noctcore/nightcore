//! Plan-approval gate (M3 §C).
//!
//! When a task runs in `plan` mode the agent calls `ExitPlanMode`, which surfaces
//! as a parked permission request (handled in `sidecar.rs`, which moves the task to
//! `waiting_approval` and stores the plan). These commands resolve that parked
//! request: approve (allow + switch the SAME session to `acceptEdits` so it builds),
//! reject (deny → failed), or refine (deny → backlog with the plan kept for edits).
//! Every transition emits `nc:task` so the board upserts by id.

use tauri::{AppHandle, Emitter, Manager};

use crate::orchestration::coordinator::Orchestrator;
use crate::provider::{PermissionDecision, Provider};
use crate::store::TaskStore;
use crate::task::{Task, TaskStatus, TASK_EVENT};

/// Resolve the parked `ExitPlanMode` request for a task with a surface decision,
/// then run `mutate` to transition the task. The session id is required (the run
/// must still be live to receive the decision); the request id is whatever is
/// parked for the task. Shared by approve/reject/refine.
async fn resolve_plan<F>(
    app: &AppHandle,
    task_id: &str,
    decision: PermissionDecision,
    mutate: F,
) -> Result<Task, String>
where
    F: FnOnce(&mut Task),
{
    let orch = app.state::<Orchestrator>();
    let store = app.state::<TaskStore>();

    let session_id = orch
        .provider
        .session_for(task_id)
        .or_else(|| store.get(task_id).and_then(|t| t.session_id))
        .ok_or_else(|| format!("no live session for task {task_id}"))?;

    // Resolve every parked request for the task (a plan run parks exactly one, but
    // draining is harmless and keeps the registry clean).
    for request_id in orch.permissions.drain_task(task_id) {
        if let Err(e) = orch
            .provider
            .decide_permission(session_id, &request_id, decision.clone())
            .await
        {
            // A failed relay leaves the session parked-waiting while the task is
            // transitioned below — surface the mismatch instead of swallowing it.
            tracing::warn!(
                target: "nightcore",
                task_id,
                request_id = %request_id,
                error = %e,
                "failed to relay plan decision to live session"
            );
        }
    }

    let task = store.mutate(task_id, mutate)?;
    let _ = app.emit(TASK_EVENT, &task);
    Ok(task)
}

/// Approve a plan: allow the parked `ExitPlanMode` AND switch the session to
/// `acceptEdits` so the SAME run builds the approved plan. Task → `in_progress`.
#[tauri::command]
pub async fn approve_task(app: AppHandle, id: String) -> Result<(), String> {
    resolve_plan(
        &app,
        &id,
        PermissionDecision::Allow {
            updated_input: None,
        },
        |task| {
            task.status = TaskStatus::InProgress;
            task.error = None;
        },
    )
    .await?;

    // Switch the live session to auto-accept so the approved build proceeds without
    // re-prompting on every edit (the neutral autonomy the Claude provider lowers to
    // the SDK `acceptEdits` mode).
    let orch = app.state::<Orchestrator>();
    let store = app.state::<TaskStore>();
    if let Some(session_id) = orch
        .provider
        .session_for(&id)
        .or_else(|| store.get(&id).and_then(|t| t.session_id))
    {
        orch.provider
            .set_autonomy(session_id, crate::contracts::AutonomyLevel::AutoAccept)
            .await?;
    }
    Ok(())
}

/// Reject a plan: deny the parked request (the session ends) and move the task to
/// `failed` so it leaves the approval column.
#[tauri::command]
pub async fn reject_task(app: AppHandle, id: String) -> Result<(), String> {
    resolve_plan(
        &app,
        &id,
        PermissionDecision::Deny {
            message: "Plan rejected by user.".to_string(),
        },
        |task| {
            task.status = TaskStatus::Failed;
            task.error = Some("Plan rejected.".to_string());
        },
    )
    .await?;
    Ok(())
}

/// Refine a plan: deny the parked request, but send the task back to `backlog` with
/// the plan retained in its description so the user can edit and re-run it.
#[tauri::command]
pub async fn refine_task(app: AppHandle, id: String) -> Result<(), String> {
    resolve_plan(
        &app,
        &id,
        PermissionDecision::Deny {
            message: "Plan sent back for refinement.".to_string(),
        },
        |task| {
            task.status = TaskStatus::Backlog;
            fold_plan_into_description(task);
            task.error = None;
        },
    )
    .await?;
    Ok(())
}

/// Keep a refined task's plan visible for editing by folding it into the
/// description (once), so re-running picks it up.
fn fold_plan_into_description(task: &mut Task) {
    let Some(plan) = task.plan.clone() else {
        return;
    };
    if task.description.contains(&plan) {
        return;
    }
    task.description = if task.description.is_empty() {
        plan
    } else {
        format!("{}\n\n--- Plan ---\n{}", task.description, plan)
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refine_folds_the_plan_into_an_empty_description_once() {
        let mut task = Task::new("t".into(), String::new());
        task.plan = Some("do the thing".into());
        fold_plan_into_description(&mut task);
        assert_eq!(task.description, "do the thing");
        // Idempotent: folding again doesn't duplicate it.
        fold_plan_into_description(&mut task);
        assert_eq!(task.description, "do the thing");
    }

    #[test]
    fn refine_appends_the_plan_below_an_existing_description() {
        let mut task = Task::new("t".into(), "existing notes".into());
        task.plan = Some("the plan".into());
        fold_plan_into_description(&mut task);
        assert!(task.description.starts_with("existing notes"));
        assert!(task.description.contains("the plan"));
    }
}
