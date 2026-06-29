//! The sidecar stdout event dispatcher: correlate each parsed event to its task,
//! forward it to the webview, relay permission prompts, and route terminal events
//! into the verification gate or the run-finish path.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::engine_api::EngineApi;
use crate::provider::SidecarProvider;
use crate::store::TaskStore;
use crate::task::{ProposedSubtask, TaskStatus};

use super::permission::{
    emit_permission_prompt, emit_question_prompt, handle_plan_gate, EXIT_PLAN_MODE,
};
use super::verification::{handle_build_completed, handle_review_completed};
use super::{apply_and_emit, finish_run, park_for_approval, Outcome, SESSION_EVENT};

/// The pure routing decision for one parsed sidecar event, extracted from all
/// `AppHandle` side-effects so it can be unit-tested with plain JSON fixtures.
#[derive(Debug, PartialEq)]
pub(crate) enum EventRoute {
    /// A `query-result` RPC reply with a known `requestId` — route to the
    /// provider's pending correlate map (NOT forwarded to the board).
    QueryResult { request_id: String },
    /// A `query-result` that is missing its `requestId` — drop it.
    QueryResultMissingId,
    /// Any `analysis-*` event — route to the insight channel by `runId`.
    Analysis,
    /// Any `harness-*` event — route to the harness channel by `runId`.
    Harness,
    /// Any `scorecard-*` event — route to the scorecard channel by `runId`.
    Scorecard,
    /// A `permission-required` for `ExitPlanMode` — park as `waiting_approval`.
    PermissionPlanGate,
    /// A `permission-required` for any other tool — surface an `nc:permission` prompt.
    PermissionGeneric,
    /// A `question-required` — surface an `nc:question` prompt.
    Question,
    /// The event has a correlatable `sessionId` — apply normal session processing.
    SessionCorrelated,
    /// The event cannot be correlated (no `sessionId` and not a special type) — drop.
    Drop,
}

/// Classify a raw sidecar event into its routing decision. This function is
/// PURE: it reads only `event` and returns an `EventRoute`; all `AppHandle`
/// side-effects live in `handle_event` which matches on the returned value.
pub(crate) fn classify_event(event: &Value) -> EventRoute {
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");

    if event_type == "query-result" {
        return match event.get("requestId").and_then(Value::as_str) {
            Some(id) => EventRoute::QueryResult {
                request_id: id.to_string(),
            },
            None => EventRoute::QueryResultMissingId,
        };
    }

    if event_type.starts_with("analysis-") {
        return EventRoute::Analysis;
    }

    if event_type.starts_with("harness-") {
        return EventRoute::Harness;
    }

    if event_type.starts_with("scorecard-") {
        return EventRoute::Scorecard;
    }

    // Session-correlated events below: all require a sessionId (or a special
    // sub-type like permission/question that we check AFTER correlation).
    if event.get("sessionId").and_then(Value::as_u64).is_none() {
        return EventRoute::Drop;
    }

    if event_type == "permission-required" {
        let tool_name = event.get("toolName").and_then(Value::as_str).unwrap_or("");
        return if tool_name == EXIT_PLAN_MODE {
            EventRoute::PermissionPlanGate
        } else {
            EventRoute::PermissionGeneric
        };
    }

    if event_type == "question-required" {
        return EventRoute::Question;
    }

    EventRoute::SessionCorrelated
}

/// Process one parsed sidecar event: correlate it to its task, forward it as
/// `nc:session`, auto-deny permission requests, and apply terminal transitions
/// (releasing the slot, cleaning up the worktree, feeding the breaker, kicking the
/// coordinator).
pub(crate) async fn handle_event(app: &AppHandle, event: Value) {
    let provider = app.state::<Arc<SidecarProvider>>();
    let engine = app.state::<Arc<dyn EngineApi>>();
    let store = app.state::<TaskStore>();

    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");

    // A `query-result` is an RPC REPLY to a `SurfaceQuery`, not a session stream
    // event: it carries a `requestId` (no `sessionId`) and must be routed back to
    // the awaiting `Provider::query` call, NOT forwarded to the board or persisted.
    if event_type == "query-result" {
        use crate::provider::Provider;
        // Own the request id before moving `event` into the reply (a borrow can't
        // outlive the move).
        let request_id = event
            .get("requestId")
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        match request_id {
            Some(request_id) => provider.correlate_reply(&request_id, event),
            None => {
                tracing::warn!(target: "sidecar", "query-result event missing its requestId; dropping")
            }
        }
        return;
    }

    // The Insight `analysis-*` family correlates by `runId` (no `sessionId`) and is
    // owned by a separate channel + store, so it is routed BEFORE the session-id
    // correlation below (which would otherwise drop it for lacking a sessionId).
    if event_type.starts_with("analysis-") {
        super::insight::handle_analysis_event(app, event_type, &event).await;
        return;
    }

    // The Harness `harness-*` family also correlates by `runId` (no `sessionId`) and is
    // owned by a separate channel + store, so it is routed BEFORE session-id correlation.
    if event_type.starts_with("harness-") {
        super::harness::handle_harness_event(app, event_type, &event).await;
        return;
    }

    // The Scorecard `scorecard-*` family also correlates by `runId` (no `sessionId`)
    // and is owned by a separate channel + store, so it is routed BEFORE session-id
    // correlation.
    if event_type.starts_with("scorecard-") {
        super::scorecard::handle_scorecard_event(app, event_type, &event).await;
        return;
    }

    let session_id = event.get("sessionId").and_then(Value::as_u64);

    // Correlate the event to its task. The first sighting of a session id binds it
    // to the task at the front of the pending-launch FIFO; later events read back
    // the binding. An uncorrelatable event (no pending launch) is dropped.
    let Some(task_id) = session_id.and_then(|sid| provider.correlate(sid)) else {
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
            engine.permissions_register(app, &task_id, request_id);
            if tool_name == EXIT_PLAN_MODE {
                handle_plan_gate(app, &store, &task_id, &event);
            } else {
                emit_permission_prompt(app, &task_id, request_id, &event);
            }
        }
        return;
    }

    // An `AskUserQuestion` parks the SDK dialog in the engine until an
    // `answer_question` command resolves it (or session teardown settles it as
    // cancelled — the engine, not the core, owns that fail-closed path, so there
    // is no Rust-side registry to drain on cancel). Relay the prompt to the board.
    if event_type == "question-required" {
        if let Some(request_id) = event.get("requestId").and_then(Value::as_str) {
            tracing::info!(target: "nightcore", task_id, "relaying ask-user-question request");
            emit_question_prompt(app, &task_id, request_id, &event);
        }
        return;
    }

    // Concurrency: drop a STALE terminal. A `session-completed`/`session-failed` can
    // arrive for a run that has since been superseded — e.g. a cancel is followed by an
    // immediate re-run that binds a new session before this one's terminal lands. Acting
    // on it would clobber the live run's state and, via `finish_run`, release the NEW
    // run's slot (launching past `max_concurrency`). Only the session the task is
    // currently bound to may settle it; forget the stale binding and bail.
    if matches!(event_type, "session-completed" | "session-failed")
        && is_stale_terminal(session_id, store.get(&task_id).and_then(|t| t.session_id))
    {
        if let Some(sid) = session_id {
            tracing::warn!(target: "nightcore", task_id, stale_session = sid, "dropping terminal for a superseded session");
            provider.forget(sid);
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
                if let Some(duration_ms) = provider.run_duration_ms(sid) {
                    tracing::info!(target: "nightcore", task_id, session_id = sid, duration_ms, "session completed");
                }
            }
            let result = event
                .get("result")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let cost = event.get("costUsd").and_then(Value::as_f64);
            // Decompose §B: the engine includes a validated `proposedSubtasks` array
            // on a `decompose` run's completion (absent for every other kind). Build
            // the core-owned `ProposedSubtask`s here — `from_wire` MINTS each one's
            // id/status/link and drops blank-title items — and hand them to the
            // build-completed path. Absent ⇒ an empty Vec (non-decompose sessions and
            // fix-build re-entries carry no proposals).
            let proposed_subtasks: Vec<ProposedSubtask> = event
                .get("proposedSubtasks")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(ProposedSubtask::from_wire).collect())
                .unwrap_or_default();
            // The phase discriminator: a completion while `Verifying` is the
            // reviewer finishing; otherwise it is a build (or fix-build) finishing.
            let status = store.get(&task_id).map(|t| t.status);
            if status == Some(TaskStatus::Verifying) {
                handle_review_completed(app, &store, &task_id, session_id, result, cost).await;
            } else {
                handle_build_completed(
                    app,
                    &store,
                    &task_id,
                    session_id,
                    result,
                    cost,
                    proposed_subtasks,
                )
                .await;
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
                if let Some(duration_ms) = provider.run_duration_ms(sid) {
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

/// A terminal event is STALE when the task is currently bound to a *different*
/// session than the one the event carries — i.e. a newer run has superseded the one
/// this terminal belongs to. Only fires when both ids are known and differ; an
/// unknown current binding (`None`) is treated as fresh so a run whose
/// `session-started` was skipped still settles normally.
fn is_stale_terminal(event_session: Option<u64>, current_session: Option<u64>) -> bool {
    matches!((event_session, current_session), (Some(e), Some(c)) if e != c)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stale_terminal_only_when_bindings_differ() {
        // Same session → fresh (the live run settling itself).
        assert!(!is_stale_terminal(Some(10), Some(10)));
        // Different session → stale (a re-run superseded this one).
        assert!(is_stale_terminal(Some(10), Some(11)));
        // Unknown current binding → fresh (don't drop a run that never set session_id).
        assert!(!is_stale_terminal(Some(10), None));
        // No event session id → nothing to compare → fresh.
        assert!(!is_stale_terminal(None, Some(11)));
        assert!(!is_stale_terminal(None, None));
    }

    #[test]
    fn query_result_without_request_id_drops() {
        let event = json!({ "type": "query-result", "data": "something" });
        assert_eq!(classify_event(&event), EventRoute::QueryResultMissingId);
    }

    #[test]
    fn query_result_with_request_id_routes_correctly() {
        let event = json!({ "type": "query-result", "requestId": "req-abc" });
        assert_eq!(
            classify_event(&event),
            EventRoute::QueryResult {
                request_id: "req-abc".to_string()
            }
        );
    }

    #[test]
    fn analysis_event_routes_before_session_id_correlation() {
        // An analysis-* event has no sessionId at all; it must route to Analysis,
        // NOT to Drop (which would happen if session-id correlation ran first).
        let event = json!({ "type": "analysis-completed", "runId": "run-1" });
        assert_eq!(classify_event(&event), EventRoute::Analysis);

        let event = json!({ "type": "analysis-category-started", "runId": "run-1" });
        assert_eq!(classify_event(&event), EventRoute::Analysis);
    }

    #[test]
    fn permission_exit_plan_mode_is_plan_gate() {
        let event = json!({
            "type": "permission-required",
            "sessionId": 42,
            "toolName": "ExitPlanMode",
            "requestId": "req-1"
        });
        assert_eq!(classify_event(&event), EventRoute::PermissionPlanGate);
    }

    #[test]
    fn permission_other_tool_is_generic() {
        let event = json!({
            "type": "permission-required",
            "sessionId": 42,
            "toolName": "Bash",
            "requestId": "req-2"
        });
        assert_eq!(classify_event(&event), EventRoute::PermissionGeneric);
    }

    #[test]
    fn question_required_routes_to_question() {
        let event = json!({
            "type": "question-required",
            "sessionId": 99,
            "requestId": "req-3"
        });
        assert_eq!(classify_event(&event), EventRoute::Question);
    }

    #[test]
    fn event_with_no_correlatable_id_drops_without_panic() {
        // No sessionId, not a special type — must drop gracefully.
        let event = json!({ "type": "session-started", "data": {} });
        assert_eq!(classify_event(&event), EventRoute::Drop);
    }

    #[test]
    fn event_with_session_id_is_session_correlated() {
        let event = json!({ "type": "session-completed", "sessionId": 7, "result": "success" });
        assert_eq!(classify_event(&event), EventRoute::SessionCorrelated);
    }

    #[test]
    fn unknown_type_with_session_id_is_session_correlated() {
        let event = json!({ "type": "some-future-event", "sessionId": 1 });
        assert_eq!(classify_event(&event), EventRoute::SessionCorrelated);
    }

    #[test]
    fn missing_type_with_no_session_id_drops() {
        let event = json!({ "payload": "unknown" });
        assert_eq!(classify_event(&event), EventRoute::Drop);
    }
}
