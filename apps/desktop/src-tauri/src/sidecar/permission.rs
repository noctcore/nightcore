//! Interactive permission relay and the plan-approval gate. A `permission-required`
//! event for `ExitPlanMode` parks the task as `waiting_approval` with its plan; any
//! other tool surfaces an `nc:permission` prompt for the webview to answer.

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::store::TaskStore;
use crate::task::TaskStatus;

use super::{apply_and_emit, PERMISSION_EVENT};

/// The tool name the SDK uses when the agent finishes a plan in `plan` mode. It
/// surfaces as a `permission-required`; the core gates it as plan approval rather
/// than a generic tool prompt.
pub(crate) const EXIT_PLAN_MODE: &str = "ExitPlanMode";

/// Surface an interactive permission prompt to the webview as `nc:permission`.
/// Forwards the tool name + input (which may contain paths/commands — never
/// logged) plus the SDK's `suggestions`, when present, so the UI can offer
/// pre-filled allow/deny choices.
pub(crate) fn emit_permission_prompt(
    app: &AppHandle,
    task_id: &str,
    request_id: &str,
    event: &Value,
) {
    let _ = app.emit(
        PERMISSION_EVENT,
        serde_json::json!({
            "taskId": task_id,
            "requestId": request_id,
            "toolName": event.get("toolName").and_then(Value::as_str).unwrap_or(""),
            "input": event.get("input").cloned().unwrap_or(Value::Null),
            "suggestions": event.get("suggestions").cloned(),
        }),
    );
}

/// The plan-approval gate (M3 §C): the agent finished a plan in `plan` mode and
/// called `ExitPlanMode`, surfacing as a `permission-required`. Transition the task
/// to `waiting_approval` and store the plan (from the tool input) so the detail
/// panel renders it; the parked request resolves later via `approve_task` /
/// `reject_task` / `refine_task`.
pub(crate) fn handle_plan_gate(app: &AppHandle, store: &TaskStore, task_id: &str, event: &Value) {
    let plan = extract_plan(event);
    apply_and_emit(app, store, task_id, |task| {
        task.status = TaskStatus::WaitingApproval;
        task.plan = plan.clone();
    });
}

/// Pull the plan text out of an `ExitPlanMode` tool input. The SDK passes the plan
/// under `input.plan`; fall back to the whole input rendered as a string so the UI
/// always has something to show.
fn extract_plan(event: &Value) -> Option<String> {
    let input = event.get("input")?;
    if let Some(plan) = input.get("plan").and_then(Value::as_str) {
        return Some(plan.to_string());
    }
    Some(input.to_string())
}
