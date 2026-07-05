//! The sidecar stdout event dispatcher: correlate each parsed event to its task,
//! forward it to the webview, relay permission prompts, and route terminal events
//! into the verification gate or the run-finish path.

use std::sync::Arc;

use serde::Serialize;
use serde_json::value::RawValue;
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

/// The `nc:session` wire envelope: a streamed engine event tagged with its task.
/// Both fields BORROW — the task id and the already-serialized event body — so
/// Tauri serializes the envelope in a single pass with no intermediate allocation.
/// The `event` is a [`RawValue`] emitted verbatim (its JSON bytes are copied, not
/// re-serialized from a `Value` tree), which is what lets the reader serialize each
/// streamed event exactly once and share those bytes with the transcript writer.
/// Mirrors the web-side `SessionEnvelope { taskId, event }` shape in `bridge.ts`.
#[derive(Serialize, Clone)]
struct TaggedSessionEvent<'a> {
    #[serde(rename = "taskId")]
    task_id: &'a str,
    event: &'a RawValue,
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

    // The PR Review `pr-review-*` family also correlates by `runId` (no `sessionId`) and
    // is owned by a separate channel + store, so it is routed BEFORE session-id correlation.
    if event_type.starts_with("pr-review-") {
        super::pr_review::handle_pr_review_event(app, event_type, &event).await;
        return;
    }

    // The Issue Triage `issue-validation-*` family correlates by `runId` (no `sessionId`)
    // and is owned by a separate channel + store, so it is routed BEFORE session-id
    // correlation (which would otherwise drop it for lacking a sessionId).
    if event_type.starts_with("issue-validation-") {
        super::issue_triage::handle_issue_validation_event(app, event_type, &event).await;
        return;
    }

    let session_id = event.get("sessionId").and_then(Value::as_u64);

    // Correlate the event to its task. The first sighting of a session id binds it
    // to the task at the front of the pending-launch FIFO; later events read back
    // the binding. An uncorrelatable event (no pending launch) is dropped.
    let Some(task_id) = session_id.and_then(|sid| provider.correlate(sid)) else {
        return;
    };

    // PR-fix probe (workflow::pr_fix): a fix session correlates by its FIX id (a
    // PrFixRegistry key, never a task id). Resolved ONCE here and consulted by
    // the stream/transcript suppression and every routing arm below.
    let is_pr_fix = app
        .state::<crate::workflow::pr_fix::PrFixRegistry>()
        .contains(&task_id);

    // Perf: forward the event to the webview AND persist it to the transcript while
    // serializing the event body EXACTLY ONCE. This is the hottest core path —
    // assistant text-delta events stream per token during a run, and payloads can be
    // multiple KB. The old code deep-cloned the whole event `Value` into a `json!`
    // wrapper (one allocation per node) and then re-serialized the same `Value` in
    // the transcript writer; instead we serialize once into a `RawValue` and share
    // those bytes with both the webview envelope (emitted verbatim) and the
    // transcript (M4.7 §C — persisted so a reload/HMR no longer blanks the stream).
    // Both are best-effort and secret-safe (the wire events carry tool inputs but
    // never tokens); a serialize/write failure never breaks the live stream.
    //
    // PR-fix intercept: a fix session's stream is SKIPPED entirely — no board
    // surface renders `nc:session` keyed by a `prfix-*` id (the emit would be
    // dead traffic), and a transcript file keyed by the fix id has no task-scoped
    // GC to ever delete it (the leak). The routing arms below still run.
    if !is_pr_fix {
        match serde_json::value::to_raw_value(&event) {
            Ok(raw) => {
                let _ = app.emit(
                    SESSION_EVENT,
                    TaggedSessionEvent {
                        task_id: &task_id,
                        event: &raw,
                    },
                );
                crate::transcript::append_line(&store, &task_id, raw.get());
            }
            // Re-serializing a just-parsed `Value` effectively cannot fail; if it somehow
            // does, drop this one event from the stream/transcript rather than killing the
            // reader (routing decisions below still run on the parsed event).
            Err(e) => {
                tracing::warn!(target: "nightcore", task_id, error = %e, "cannot serialize session event; dropping from stream/transcript");
            }
        }
    }

    // M3: a permission request is relayed, not auto-denied. The plan gate
    // (`ExitPlanMode`) transitions the task to `waiting_approval` and stores the
    // plan; any other tool surfaces an interactive `nc:permission` prompt. Both
    // park in the engine until `respond_permission` (or a fail-closed deny on
    // cancel) resolves them.
    if event_type == "permission-required" {
        if let Some(request_id) = event.get("requestId").and_then(Value::as_str) {
            let tool_name = event.get("toolName").and_then(Value::as_str).unwrap_or("");
            // PR-fix intercept (workflow::pr_fix): no board surface renders a
            // prompt keyed by a `prfix-*` id, so relaying would park the session
            // on a spinner NO ONE can answer — forever. FAIL-CLOSED: deny at
            // once through the same per-request seam `deny_parked_permissions`
            // resolves through, and let the session adapt (the dontAsk shape).
            // Covers the ExitPlanMode plan gate too — a fix has no task row to
            // park `waiting_approval` on. Deliberately NOT registered in the
            // engine permission registry (nothing would ever drain it) and NOT
            // emitted to the web.
            if is_pr_fix {
                tracing::warn!(target: "nightcore::prfix", fix_id = %task_id, tool = tool_name, "denying a pr-fix session's permission request (unattended run)");
                if let Some(sid) = session_id {
                    use crate::provider::{PermissionDecision, Provider};
                    if let Err(e) = provider
                        .decide_permission(
                            sid,
                            request_id,
                            PermissionDecision::Deny {
                                message: "Nightcore: PR-fix sessions run unattended — this \
                                          permission request was denied; continue without the \
                                          tool call if possible."
                                    .to_string(),
                            },
                        )
                        .await
                    {
                        tracing::warn!(target: "nightcore::prfix", fix_id = %task_id, error = %e, "failed to deny a pr-fix permission request");
                    }
                }
                return;
            }
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
            // PR-fix intercept: same fail-closed rule as `permission-required` —
            // no surface renders an `nc:question` keyed by a fix id, so CANCEL
            // the SDK dialog at once (the engine settles it as cancelled)
            // instead of parking the session forever. Not emitted to the web.
            if is_pr_fix {
                tracing::warn!(target: "nightcore::prfix", fix_id = %task_id, "cancelling a pr-fix session's ask-user-question (unattended run)");
                if let Some(sid) = session_id {
                    use crate::provider::Provider;
                    if let Err(e) = provider
                        .send_answer(
                            sid,
                            request_id,
                            crate::contracts::AnswerQuestionAnswerUnion::Cancel {},
                        )
                        .await
                    {
                        tracing::warn!(target: "nightcore::prfix", fix_id = %task_id, error = %e, "failed to cancel a pr-fix ask-user-question");
                    }
                }
                return;
            }
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
                // PR-fix intercept (workflow::pr_fix): a fix session correlates by
                // its FIX id, which has no task row to stamp. The provider
                // correlation map already carries the binding cancel needs
                // (`session_for`), so skip the task-store stamp instead of logging
                // a spurious mutate failure for a nonexistent task.
                if is_pr_fix {
                    return;
                }
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
            // PR-fix intercept (workflow::pr_fix): a pr-fix session's correlation
            // id is a PrFixRegistry key, NOT a task id — route its completion to
            // the pr-fix arc (auto-commit → awaiting_push) BEFORE the task-store
            // routing below, which would otherwise misread the missing task as a
            // fresh build completion. The commit is blocking git work, so it is
            // offloaded off the reader exactly like the gate battery. A pr-fix
            // run holds no slot and feeds no breaker, so `finish_run` bookkeeping
            // is deliberately NOT involved; the correlation binding is dropped
            // here (the terminal handlers below do the same via their paths).
            if is_pr_fix {
                if let Some(sid) = session_id {
                    provider.forget(sid);
                }
                let app = app.clone();
                let fix_id = task_id.clone();
                tauri::async_runtime::spawn(async move {
                    crate::workflow::pr_fix::handle_fix_completed(&app, &fix_id, result, cost)
                        .await;
                });
                return;
            }
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
            // Perf (#1): OFFLOAD the terminal gate battery off the reader task. The
            // completed event was already streamed + persisted inline above (in wire
            // order); here we hand the heavy tail — `handle_build_completed`'s commit +
            // structure-lock gauntlet + gate battery + reviewer dispatch, or
            // `handle_review_completed`'s verdict routing — to a spawned task so the
            // reader returns AT ONCE to `read_capped_line` and keeps draining stdout for
            // every other concurrent session (previously this ran inline for seconds,
            // head-of-line-blocking all live token streams). Per-task ordering is
            // preserved: the build session is terminal (it emits no further events), and
            // no reviewer/fix event for this task can reach the wire until the spawned
            // handler dispatches the next session — its final step — so nothing for this
            // task races ahead of it. Uses `tauri::async_runtime::spawn` (never bare
            // `tokio::spawn`, which aborts off-runtime — see `finish_run`'s guard).
            let app = app.clone();
            let task_id = task_id.clone();
            tauri::async_runtime::spawn(async move {
                let store = app.state::<TaskStore>();
                if status == Some(TaskStatus::Verifying) {
                    handle_review_completed(&app, &store, &task_id, session_id, result, cost).await;
                } else {
                    handle_build_completed(
                        &app,
                        &store,
                        &task_id,
                        session_id,
                        result,
                        cost,
                        proposed_subtasks,
                    )
                    .await;
                }
            });
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
            // PR-fix intercept (workflow::pr_fix): same routing rule as the
            // session-completed arm — a fix session's failure marks its
            // PrFixState failed and must never touch the task store, the circuit
            // breaker, or a slot (a pr-fix run leases none). A cancel already
            // marked it failed("cancelled"), in which case this is a no-op.
            if is_pr_fix {
                if let Some(sid) = session_id {
                    provider.forget(sid);
                }
                crate::workflow::pr_fix::handle_fix_failed(app, &task_id, message);
                return;
            }
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
                    // Structured error taxonomy: a fatal-setup category (auth /
                    // disk-full) trips the breaker at once so the auto-loop stops
                    // rather than burning more tasks that fail identically.
                    let fatal = is_fatal_setup_failure(&event);
                    tracing::error!(target: "nightcore", task_id, session_id = ?session_id, fatal, error = message.as_deref().unwrap_or("<none>"), "run failed");
                    Outcome::Failed { fatal }
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

/// Whether a `session-failed` event names a FATAL-setup failure the breaker must
/// stop the loop on immediately (auth / disk-full), reading the structured
/// [`ErrorCategory`] from the event's `detail`. Backward-compatible: an older
/// engine that emits no `detail` falls back to the legacy `reason` — an
/// `authentication` reason is still treated as fatal — so a broken credential
/// stops the loop regardless of engine version.
fn is_fatal_setup_failure(event: &Value) -> bool {
    use crate::contracts::ErrorCategory;
    use crate::orchestration::breaker::trips_breaker_immediately;

    let category: Option<ErrorCategory> = event
        .get("detail")
        .and_then(|d| d.get("category"))
        .and_then(|c| serde_json::from_value(c.clone()).ok());
    match category {
        Some(category) => trips_breaker_immediately(category),
        None => event.get("reason").and_then(Value::as_str) == Some("authentication"),
    }
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
    fn fatal_setup_failure_reads_structured_category() {
        // auth / disk-full categories are fatal-setup → trip the breaker at once.
        let auth = json!({
            "type": "session-failed", "sessionId": 1, "reason": "authentication",
            "message": "no", "detail": { "category": "auth", "message": "no", "retriable": false }
        });
        assert!(is_fatal_setup_failure(&auth));
        let disk = json!({
            "type": "session-failed", "sessionId": 1, "reason": "runner-crash",
            "message": "ENOSPC", "detail": { "category": "disk-full", "message": "ENOSPC", "retriable": false }
        });
        assert!(is_fatal_setup_failure(&disk));
        // A transient category is NOT fatal → stays on the tolerant window.
        let rate = json!({
            "type": "session-failed", "sessionId": 1, "reason": "rate-limit",
            "message": "slow", "detail": { "category": "rate-limit", "message": "slow", "retriable": true }
        });
        assert!(!is_fatal_setup_failure(&rate));
    }

    #[test]
    fn fatal_setup_failure_falls_back_to_legacy_reason() {
        // Backward-compat: an older engine emits no `detail`. An `authentication`
        // reason is still fatal; every other bare reason stays transient.
        let auth = json!({
            "type": "session-failed", "sessionId": 1, "reason": "authentication", "message": "no"
        });
        assert!(is_fatal_setup_failure(&auth));
        let crash = json!({
            "type": "session-failed", "sessionId": 1, "reason": "runner-crash", "message": "boom"
        });
        assert!(!is_fatal_setup_failure(&crash));
    }

    #[test]
    fn pr_fix_permission_prompt_is_denied_never_relayed() {
        // Contract guard: no board surface renders an `nc:permission` (or the
        // plan gate) keyed by a `prfix-*` id — relaying would park the session
        // on a prompt no one can ever answer. The permission-required arm must
        // fail-closed DENY (via the per-request `decide_permission` seam) BEFORE
        // any of the relay paths (register / plan gate / emit). The arm needs a
        // full `AppHandle`, so this is a source-level guard (like the offload
        // test below).
        let src = include_str!("reader.rs");
        let arm_at = src
            .find("if event_type == \"permission-required\"")
            .expect("the permission-required arm exists");
        let arm_end = src[arm_at..]
            .find("if event_type == \"question-required\"")
            .map(|rel| arm_at + rel)
            .unwrap_or(src.len());
        let arm = &src[arm_at..arm_end];
        let guard = arm
            .find("if is_pr_fix")
            .expect("the pr-fix intercept exists in the permission arm");
        let deny = arm
            .find("PermissionDecision::Deny")
            .expect("the intercept denies the request");
        let register = arm
            .find("permissions_register")
            .expect("the relay path registers the request");
        let emit = arm
            .find("emit_permission_prompt")
            .expect("the relay path emits nc:permission");
        let plan_gate = arm
            .find("handle_plan_gate")
            .expect("the plan gate lives in this arm");
        assert!(guard < deny, "the intercept denies inside the guard");
        assert!(
            deny < register && deny < emit && deny < plan_gate,
            "the fail-closed deny must run BEFORE every relay path (incl. the plan gate)"
        );
    }

    #[test]
    fn pr_fix_question_prompt_is_cancelled_never_relayed() {
        // Same fail-closed rule for `question-required`: cancel the SDK dialog
        // at once instead of emitting an `nc:question` no surface renders.
        let src = include_str!("reader.rs");
        let arm_at = src
            .find("if event_type == \"question-required\"")
            .expect("the question-required arm exists");
        let arm_end = src[arm_at..]
            .find("\"session-completed\" | \"session-failed\"")
            .map(|rel| arm_at + rel)
            .unwrap_or(src.len());
        let arm = &src[arm_at..arm_end];
        let guard = arm
            .find("if is_pr_fix")
            .expect("the pr-fix intercept exists in the question arm");
        let cancel = arm
            .find("AnswerQuestionAnswerUnion::Cancel")
            .expect("the intercept cancels the dialog");
        let emit = arm
            .find("emit_question_prompt")
            .expect("the relay path emits nc:question");
        assert!(
            guard < cancel && cancel < emit,
            "the fail-closed cancel must run BEFORE the relay emit"
        );
    }

    #[test]
    fn pr_fix_stream_and_transcript_are_suppressed() {
        // Leak guard: a fix session's `nc:session` emit is dead traffic (no
        // surface renders a `prfix-*` taskId) and its transcript file has no
        // task-scoped GC to ever delete it. The single emit+append block must
        // sit under the `!is_pr_fix` guard.
        let src = include_str!("reader.rs");
        let guard = src
            .find("if !is_pr_fix {")
            .expect("the stream-suppression guard exists");
        let arm_end = src
            .find("if event_type == \"permission-required\"")
            .expect("the next routing arm bounds the block");
        assert!(guard < arm_end, "the guard precedes the routing arms");
        let guarded = &src[guard..arm_end];
        // Assembled needle so this test's own source can't satisfy the count.
        let append = concat!("crate::transcript::", "append_line");
        assert!(
            guarded.contains(append),
            "the transcript append is inside the guard"
        );
        assert_eq!(
            src.matches(append).count(),
            1,
            "no unguarded transcript append exists elsewhere in the reader"
        );
    }

    #[test]
    fn session_completed_offloads_the_gate_battery_off_the_reader() {
        // Perf regression guard (#1): the `session-completed` arm must dispatch the
        // heavy terminal handlers (`handle_build_completed`/`handle_review_completed` —
        // commit + gauntlet + gate battery + reviewer dispatch) OFF the reader task via
        // `tauri::async_runtime::spawn`, so one task's multi-second gates never
        // head-of-line-block every other concurrent session's live token stream. The
        // handlers need a full `AppHandle`, so this is a source-level guard (like
        // `finish_run_breaker_trip_uses_the_guarded_spawn` in `mod.rs`).
        let src = include_str!("reader.rs");
        let at = src
            .find("\"session-completed\" => {")
            .expect("the session-completed arm must exist");
        // Bound the window to this arm (up to the next terminal arm) so the assertion
        // is about THIS arm's dispatch, not an unrelated spawn elsewhere in the file.
        let end = src[at..]
            .find("\"session-failed\" => {")
            .map(|rel| at + rel)
            .unwrap_or(src.len());
        let arm = &src[at..end];
        assert!(
            arm.contains("tauri::async_runtime::spawn(async move {"),
            "session-completed must offload the gate battery via tauri::async_runtime::spawn"
        );
        assert!(
            arm.contains("handle_build_completed(") && arm.contains("handle_review_completed("),
            "both terminal handlers must be dispatched from the offloaded task"
        );
        let bare_spawn = concat!("tokio", "::spawn(");
        assert!(
            !arm.contains(bare_spawn),
            "must NOT use bare tokio::spawn — it aborts off-runtime (SIGABRT)"
        );
    }
}
