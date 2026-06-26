//! Interactive prompt relays and the plan-approval gate. A `permission-required`
//! event for `ExitPlanMode` parks the task as `waiting_approval` with its plan; any
//! other tool surfaces an `nc:permission` prompt for the webview to answer. A
//! `question-required` event (the SDK's `AskUserQuestion`) surfaces an `nc:question`
//! prompt the webview answers via the `answer_question` command.

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::store::TaskStore;
use crate::task::TaskStatus;

use super::{apply_and_emit, PERMISSION_EVENT, QUESTION_EVENT};

/// The tool name the SDK uses when the agent finishes a plan in `plan` mode. It
/// surfaces as a `permission-required`; the core gates it as plan approval rather
/// than a generic tool prompt.
pub(crate) const EXIT_PLAN_MODE: &str = "ExitPlanMode";

/// Build the `nc:permission` payload for an interactive permission prompt.
/// Exported as a pure builder so it can be unit-tested without an AppHandle.
pub(crate) fn build_permission_payload(
    task_id: &str,
    request_id: &str,
    event: &Value,
) -> Value {
    serde_json::json!({
        "taskId": task_id,
        "requestId": request_id,
        "toolName": event.get("toolName").and_then(Value::as_str).unwrap_or(""),
        "input": event.get("input").cloned().unwrap_or(Value::Null),
        "suggestions": event.get("suggestions").cloned(),
    })
}

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
    let _ = app.emit(PERMISSION_EVENT, build_permission_payload(task_id, request_id, event));
}

/// Build the `nc:question` payload for an interactive AskUserQuestion prompt.
/// Exported as a pure builder so it can be unit-tested without an AppHandle.
/// `toolUseId` is included only when the event carried a non-null value, so the
/// web type stays `string | undefined` rather than receiving an explicit null.
pub(crate) fn build_question_payload(task_id: &str, request_id: &str, event: &Value) -> Value {
    let mut payload = serde_json::json!({
        "taskId": task_id,
        "requestId": request_id,
        "questions": event.get("questions").cloned().unwrap_or(Value::Null),
    });
    if let Some(tool_use_id) = event.get("toolUseId").filter(|v| !v.is_null()) {
        payload["toolUseId"] = tool_use_id.clone();
    }
    payload
}

/// Surface an interactive `AskUserQuestion` prompt to the webview as `nc:question`.
/// Forwards the question/option text (which the model authored — surfaced to the UI
/// but never logged) plus the originating `toolUseId` when the dialog carried one,
/// so the board can correlate the prompt with its transcript entry. The webview
/// answers via the `answer_question` command.
pub(crate) fn emit_question_prompt(
    app: &AppHandle,
    task_id: &str,
    request_id: &str,
    event: &Value,
) {
    let _ = app.emit(QUESTION_EVENT, build_question_payload(task_id, request_id, event));
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── extract_plan ───────────────────────────────────────────────────────────

    #[test]
    fn extract_plan_reads_input_plan_field() {
        let event = json!({ "input": { "plan": "Step 1: do X\nStep 2: do Y" } });
        assert_eq!(
            extract_plan(&event),
            Some("Step 1: do X\nStep 2: do Y".to_string())
        );
    }

    #[test]
    fn extract_plan_falls_back_to_input_to_string_when_no_plan_key() {
        let event = json!({ "input": { "other": "value" } });
        let result = extract_plan(&event);
        // The fallback renders the whole input as a JSON string — not None.
        assert!(result.is_some(), "should fall back to input.to_string(), not None");
        let s = result.unwrap();
        assert!(s.contains("other"), "fallback string should include the input content");
    }

    #[test]
    fn extract_plan_returns_none_when_input_absent() {
        let event = json!({ "type": "permission-required", "toolName": "ExitPlanMode" });
        assert_eq!(extract_plan(&event), None);
    }

    // ── build_permission_payload ───────────────────────────────────────────────

    #[test]
    fn build_permission_payload_includes_required_fields() {
        let event = json!({
            "toolName": "Bash",
            "input": { "command": "ls" },
            "suggestions": ["allow", "deny"]
        });
        let payload = build_permission_payload("task-1", "req-1", &event);
        assert_eq!(payload["taskId"], "task-1");
        assert_eq!(payload["requestId"], "req-1");
        assert_eq!(payload["toolName"], "Bash");
        assert_eq!(payload["input"]["command"], "ls");
        assert!(payload["suggestions"].is_array());
    }

    #[test]
    fn build_permission_payload_missing_tool_name_defaults_to_empty_string() {
        let event = json!({ "input": {} });
        let payload = build_permission_payload("task-1", "req-1", &event);
        assert_eq!(payload["toolName"], "");
    }

    #[test]
    fn build_permission_payload_missing_input_defaults_to_null() {
        let event = json!({ "toolName": "Read" });
        let payload = build_permission_payload("task-1", "req-1", &event);
        assert!(payload["input"].is_null());
    }

    #[test]
    fn build_permission_payload_missing_suggestions_is_null() {
        let event = json!({ "toolName": "Read", "input": {} });
        let payload = build_permission_payload("task-1", "req-1", &event);
        assert!(payload["suggestions"].is_null());
    }

    // ── build_question_payload ─────────────────────────────────────────────────

    #[test]
    fn build_question_payload_includes_required_fields() {
        let event = json!({
            "questions": [{ "question": "Which approach?", "options": ["A", "B"] }]
        });
        let payload = build_question_payload("task-2", "req-2", &event);
        assert_eq!(payload["taskId"], "task-2");
        assert_eq!(payload["requestId"], "req-2");
        assert!(payload["questions"].is_array());
    }

    #[test]
    fn build_question_payload_includes_tool_use_id_when_present() {
        let event = json!({
            "questions": [],
            "toolUseId": "toolu_abc123"
        });
        let payload = build_question_payload("task-2", "req-2", &event);
        assert_eq!(payload["toolUseId"], "toolu_abc123");
    }

    #[test]
    fn build_question_payload_omits_tool_use_id_when_absent() {
        let event = json!({ "questions": [] });
        let payload = build_question_payload("task-2", "req-2", &event);
        assert!(
            payload.get("toolUseId").is_none(),
            "toolUseId key must be absent, not null, when not in event"
        );
    }

    #[test]
    fn build_question_payload_omits_tool_use_id_when_null() {
        // The event may explicitly carry toolUseId: null — we must still omit the key.
        let event = json!({ "questions": [], "toolUseId": null });
        let payload = build_question_payload("task-2", "req-2", &event);
        assert!(
            payload.get("toolUseId").is_none(),
            "explicit null toolUseId must be omitted from payload"
        );
    }

    #[test]
    fn build_question_payload_missing_questions_defaults_to_null() {
        let event = json!({ "toolUseId": "toolu_x" });
        let payload = build_question_payload("task-2", "req-2", &event);
        assert!(payload["questions"].is_null());
    }
}
