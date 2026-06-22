//! The sidecar stdout event dispatcher: correlate each parsed event to its task,
//! forward it to the webview, relay permission prompts, and route terminal events
//! into the verification gate or the run-finish path.

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::m2::coordinator::Orchestrator;
use crate::store::TaskStore;
use crate::task::TaskStatus;

use super::permission::{emit_permission_prompt, handle_plan_gate, EXIT_PLAN_MODE};
use super::verification::{handle_build_completed, handle_review_completed};
use super::{apply_and_emit, finish_run, park_for_approval, Outcome, SESSION_EVENT};

/// Process one parsed sidecar event: correlate it to its task, forward it as
/// `nc:session`, auto-deny permission requests, and apply terminal transitions
/// (releasing the slot, cleaning up the worktree, feeding the breaker, kicking the
/// coordinator).
pub(crate) async fn handle_event(app: &AppHandle, event: Value) {
    let orch = app.state::<Orchestrator>();
    let store = app.state::<TaskStore>();

    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    let session_id = event.get("sessionId").and_then(Value::as_u64);

    // Correlate the event to its task. The first sighting of a session id binds it
    // to the task at the front of the pending-launch FIFO; later events read back
    // the binding. An uncorrelatable event (no pending launch) is dropped.
    let Some(task_id) = session_id.and_then(|sid| orch.provider.correlate(sid)) else {
        return;
    };

    // Forward the raw event to the webview tagged with its task.
    let _ = app.emit(
        SESSION_EVENT,
        serde_json::json!({ "taskId": task_id, "event": event }),
    );

    // M4.7 §C: persist the same event to the task's transcript so a reload/HMR no
    // longer blanks the stream. Best-effort and secret-safe (the wire events carry
    // tool inputs but never tokens); a write failure never breaks the live stream.
    crate::transcript::append_event(&store, &task_id, &event);

    // M3: a permission request is relayed, not auto-denied. The plan gate
    // (`ExitPlanMode`) transitions the task to `waiting_approval` and stores the
    // plan; any other tool surfaces an interactive `nc:permission` prompt. Both
    // park in the engine until `respond_permission` (or a fail-closed deny on
    // cancel) resolves them.
    if event_type == "permission-required" {
        if let Some(request_id) = event.get("requestId").and_then(Value::as_str) {
            let tool_name = event.get("toolName").and_then(Value::as_str).unwrap_or("");
            // Relay by tool NAME only — never the input args (paths/commands/secrets).
            tracing::info!(target: "nightcore", task_id, tool = tool_name, "relaying permission request");
            orch.permissions.register(&task_id, request_id);
            if tool_name == EXIT_PLAN_MODE {
                handle_plan_gate(app, &store, &task_id, &event);
            } else {
                emit_permission_prompt(app, &task_id, request_id, &event);
            }
        }
        return;
    }

    match event_type {
        "session-started" | "session-ready" => {
            if let Some(sid) = session_id {
                tracing::info!(target: "nightcore", task_id, session_id = sid, "session ready");
                // SDK-guardrails (resume): persist the SDK session UUID carried by
                // `session-ready` so a later relaunch can reattach via
                // `Options.resume`. The UUID is bookkeeping, not a secret — captured
                // here, threaded on relaunch, but never logged at info/telemetry.
                let sdk_session_id = event
                    .get("sdkSessionId")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string());
                apply_and_emit(app, &store, &task_id, |task| {
                    task.session_id = Some(sid);
                    if let Some(ref sdk_id) = sdk_session_id {
                        task.sdk_session_id = Some(sdk_id.clone());
                    }
                });
            }
        }
        "session-completed" => {
            // Observability #5: log the run's wall-clock duration before the terminal
            // handlers `forget` the session (after which the timer is gone).
            if let Some(sid) = session_id {
                if let Some(duration_ms) = orch.provider.run_duration_ms(sid) {
                    tracing::info!(target: "nightcore", task_id, session_id = sid, duration_ms, "session completed");
                }
            }
            let result = event
                .get("result")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let cost = event.get("costUsd").and_then(Value::as_f64);
            // The phase discriminator: a completion while `Verifying` is the
            // reviewer finishing; otherwise it is a build (or fix-build) finishing.
            let status = store.get(&task_id).map(|t| t.status);
            if status == Some(TaskStatus::Verifying) {
                handle_review_completed(app, &store, &task_id, session_id, result, cost).await;
            } else {
                handle_build_completed(app, &store, &task_id, session_id, result, cost).await;
            }
        }
        "session-failed" => {
            // A user-initiated cancel or a circuit-breaker pause interrupts the run
            // and surfaces as `session-failed { reason: "aborted" }`. An abort is
            // not a "broken setup" signal, so it must NOT count toward the breaker
            // (otherwise cancelling a few tasks would trip it).
            let aborted = event.get("reason").and_then(Value::as_str) == Some("aborted");
            // Observability #5: capture the run duration before the terminal forget.
            if let Some(sid) = session_id {
                if let Some(duration_ms) = orch.provider.run_duration_ms(sid) {
                    tracing::info!(target: "nightcore", task_id, session_id = sid, duration_ms, aborted, "session ended (failed/aborted)");
                }
            }
            let message = event
                .get("message")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let was_verifying =
                store.get(&task_id).map(|t| t.status) == Some(TaskStatus::Verifying);

            if was_verifying && !aborted {
                // A genuine reviewer/fix crash makes verification inconclusive: park
                // for human approval (don't feed the breaker — a review crash is not
                // a broken build setup), retain the worktree for inspection (M4 §B).
                tracing::warn!(target: "nightcore", task_id, session_id = ?session_id, "reviewer/fix run crashed; parking for approval");
                apply_and_emit(app, &store, &task_id, |task| {
                    task.status = TaskStatus::WaitingApproval;
                    task.verified = false;
                    task.error = message.clone();
                    task.session_id = session_id;
                });
                park_for_approval(app, &task_id, session_id);
            } else {
                apply_and_emit(app, &store, &task_id, |task| {
                    task.status = TaskStatus::Failed;
                    task.error = message.clone();
                    task.session_id = session_id;
                });
                let outcome = if aborted {
                    tracing::info!(target: "nightcore", task_id, session_id = ?session_id, "run aborted");
                    Outcome::Aborted
                } else {
                    tracing::error!(target: "nightcore", task_id, session_id = ?session_id, error = message.as_deref().unwrap_or("<none>"), "run failed");
                    Outcome::Failed
                };
                finish_run(app, &task_id, session_id, outcome);
            }
        }
        _ => {}
    }
}
