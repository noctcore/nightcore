//! Plan-approval gate (M3 §C).
//!
//! When a task runs in `plan` mode the agent calls `ExitPlanMode`, which surfaces
//! as a parked permission request (handled in `sidecar.rs`, which moves the task to
//! `waiting_approval` and stores the plan). These commands resolve that parked
//! request: approve (allow + switch the SAME session to `acceptEdits` so it builds),
//! reject (deny → failed), or refine (reject-with-feedback — deny with the user's
//! feedback as the message, which the SDK hands back to the model so the SAME session
//! revises the plan and re-parks). Every transition emits `nc:task` so the board
//! upserts by id.
//!
//! GUARANTEE (T6, #147): a parked plan waits INDEFINITELY for a human decision — no
//! timeout/idle path ever auto-approves or auto-fails it. See the module tests below
//! (the Rust orchestration invariants) and `session-runner.test.ts` (the engine idle
//! watchdog, which pauses while a permission is pending).

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

/// Refine a plan (reject-with-feedback): DENY the parked `ExitPlanMode` with the
/// user's feedback as the message. The SDK delivers that message back to the model as
/// the `ExitPlanMode` tool result, and the SAME streaming session keeps running — the
/// agent revises the plan IN-SESSION (it stays in `plan` mode, so it re-parks with a
/// fresh plan for another approval round). The task returns to `in_progress` while it
/// re-plans, so no run context or cost is lost (unlike a fresh re-run). A blank field
/// still nudges a revision with a generic prompt. Unlike `approve_task`, the session
/// autonomy is deliberately NOT switched — plan mode must persist so it re-plans.
#[tauri::command]
pub async fn refine_task(app: AppHandle, id: String, feedback: String) -> Result<(), String> {
    resolve_plan(
        &app,
        &id,
        PermissionDecision::Deny {
            message: refinement_message(&feedback),
        },
        |task| {
            task.status = TaskStatus::InProgress;
            task.error = None;
        },
    )
    .await?;
    Ok(())
}

/// Build the denial message that carries the user's refine feedback back into the
/// live session as the `ExitPlanMode` tool result (the "refinement prompt"). A blank
/// field falls back to a generic nudge so Refine is always actionable.
fn refinement_message(feedback: &str) -> String {
    let trimmed = feedback.trim();
    if trimmed.is_empty() {
        "Please revise the plan before proceeding.".to_string()
    } else {
        format!("Please revise the plan per this feedback:\n\n{trimmed}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::coordinator::reconcile::reconcile_task_inner;
    use crate::orchestration::deps::is_launchable_status;

    #[test]
    fn refinement_message_carries_the_feedback_verbatim() {
        let msg = refinement_message("use a worker pool, not threads");
        assert!(
            msg.contains("use a worker pool, not threads"),
            "the user's feedback is relayed into the session as the refinement prompt"
        );
    }

    #[test]
    fn refinement_message_falls_back_to_a_generic_nudge_when_blank() {
        // A blank/whitespace field still produces an actionable revision prompt.
        for blank in ["", "   ", "\n\t"] {
            let msg = refinement_message(blank);
            assert!(
                !msg.trim().is_empty(),
                "a blank feedback field must still relay a non-empty refinement prompt"
            );
        }
    }

    /// T6 (#147) GUARANTEE: a parked plan (`waiting_approval`) is NEVER auto-resolved
    /// — no timeout/idle path auto-approves OR auto-fails it. Here we pin the two
    /// Rust periodic/recovery paths that could otherwise touch it; the engine-side
    /// idle watchdog exclusion is pinned in `session-runner.test.ts`.
    #[test]
    fn a_parked_plan_is_never_auto_resolved_by_the_watchdog() {
        // The auto-loop tick only launches Ready/Backlog tasks — it can never pick up
        // a parked plan and silently re-dispatch it.
        assert!(
            !is_launchable_status(TaskStatus::WaitingApproval),
            "the auto-loop must never launch a waiting_approval task"
        );
        // Boot/crash reconciliation only requeues in-flight (InProgress/Verifying)
        // work — a waiting_approval plan is left exactly as parked (no auto-approve,
        // no auto-fail), so an app restart cleanly re-surfaces the same gate.
        assert!(
            reconcile_task_inner(&TaskStatus::WaitingApproval).is_none(),
            "boot reconciliation must never auto-resolve a parked plan"
        );
    }
}
