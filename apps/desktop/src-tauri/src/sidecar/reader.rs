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
use super::{
    apply_and_emit, finish_run, notify_awaiting_input, park_for_approval, Outcome, DEBATE_EVENT,
    SESSION_EVENT,
};

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

/// The terminal-failure event type each scan family's crash-reap emits — the SAME
/// literal the family's own `handle_*_event` matches on AND the contract declares, so
/// it both marks the run failed AND passes the web's event `safeParse`. Harness is the
/// ONE family carrying the `-scan-` infix (`harness-scan-failed`); the other four are
/// `<family>-failed`. A regression test validates each against the codegen'd contract
/// fixtures, so a wrong literal (which would silently miss the handler's `_ => {}` and
/// leave the run `running`) can never ship again.
const INSIGHT_CRASH_FAILED_TYPE: &str = "analysis-failed";
const HARNESS_CRASH_FAILED_TYPE: &str = "harness-scan-failed";
const SCORECARD_CRASH_FAILED_TYPE: &str = "scorecard-failed";
const PR_REVIEW_CRASH_FAILED_TYPE: &str = "pr-review-failed";
const ISSUE_VALIDATION_CRASH_FAILED_TYPE: &str = "issue-validation-failed";

/// The synthetic `*-failed` event a crash-reap routes through a family handler.
/// Matches the contract's failed-event shape (`{ type, runId, reason, message }`)
/// EXACTLY so the web's `NightcoreEventSchema.safeParse` accepts it and folds the live
/// view to failed. `runner-crash` is a member of the shared `scanFailure` reason enum
/// (and a valid free string for the pr-review / issue-validation families).
fn crash_failed_event(event_type: &str, run_id: &str) -> Value {
    serde_json::json!({
        "type": event_type,
        "runId": run_id,
        "reason": "runner-crash",
        "message": "Sidecar exited mid-run — scan reaped.",
    })
}

/// Fail every in-flight SCAN run when the sidecar process exits (T14). Scans correlate
/// by `runId`, not `sessionId`, so `handle_sidecar_crash`'s session-based task recovery
/// never sees them — a running scan would otherwise sit `running` until the next boot's
/// `reap_running`. For each of the five families, snapshot its running run ids and route
/// the family's own synthetic `*-failed` event through the SAME handler a real failure
/// uses: that both marks the persisted run `failed` AND forwards the event to the family
/// channel, so an OPEN scan view stops spinning live rather than only on the next
/// refetch. Idempotent — a run that finalized between the snapshot and the reap is a
/// no-op under the handler's own dedupe. The `running_ids()` snapshot drops the state
/// guard before the awaits, so nothing is held across an `.await`.
pub(crate) async fn reap_scans_on_crash(app: &AppHandle) {
    for run_id in app
        .state::<crate::store::insight::InsightStore>()
        .running_ids()
    {
        let event = crash_failed_event(INSIGHT_CRASH_FAILED_TYPE, &run_id);
        super::insight::handle_analysis_event(app, INSIGHT_CRASH_FAILED_TYPE, &event).await;
    }
    for run_id in app
        .state::<crate::store::harness::HarnessStore>()
        .running_ids()
    {
        // Harness is the ONE family whose terminal-failure event carries the `-scan-`
        // infix (`harness-scan-failed`) — the other four are `<family>-failed`. Using
        // the wrong literal would miss the handler's match arm (run left `running`) AND
        // fail the web's `safeParse` (no `harness-failed` in the schema).
        let event = crash_failed_event(HARNESS_CRASH_FAILED_TYPE, &run_id);
        super::harness::handle_harness_event(app, HARNESS_CRASH_FAILED_TYPE, &event).await;
    }
    for run_id in app
        .state::<crate::store::scorecard::ScorecardStore>()
        .running_ids()
    {
        let event = crash_failed_event(SCORECARD_CRASH_FAILED_TYPE, &run_id);
        super::scorecard::handle_scorecard_event(app, SCORECARD_CRASH_FAILED_TYPE, &event).await;
    }
    for run_id in app
        .state::<crate::store::pr_review::PrReviewStore>()
        .running_ids()
    {
        let event = crash_failed_event(PR_REVIEW_CRASH_FAILED_TYPE, &run_id);
        super::pr_review::handle_pr_review_event(app, PR_REVIEW_CRASH_FAILED_TYPE, &event).await;
    }
    for run_id in app
        .state::<crate::store::issue_triage::IssueValidationStore>()
        .running_ids()
    {
        let event = crash_failed_event(ISSUE_VALIDATION_CRASH_FAILED_TYPE, &run_id);
        super::issue_triage::handle_issue_validation_event(
            app,
            ISSUE_VALIDATION_CRASH_FAILED_TYPE,
            &event,
        )
        .await;
    }
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

    // The Council `debate-*` family (the `debate-entry` transcript stream, issue #352)
    // correlates by its wrapped `runId` (no `sessionId`) and is owned by the dedicated
    // `nc:debate` channel, so it is routed BEFORE session-id correlation. There is no
    // Rust-side store: the append-only transcript lives in the engine (auditable +
    // replayable — safety #7), and the canvas folds the LIVE stream, so the reader just
    // forwards the entry verbatim (like Insight forwards `analysis-*`). The canvas only
    // READS this stream — nothing here feeds text back into a seat prompt (the mediated,
    // quoted, injection-scanned bus stays the sole cross-seat path — safety #1/#2).
    if event_type.starts_with("debate-") {
        let _ = app.emit(DEBATE_EVENT, &event);
        return;
    }

    // The Council write-capable worktree seam (issue #383): a `worktree-op-required` event
    // is the in-engine Council asking the host to `allocate`/`commit`/`gauntlet` on its
    // behalf. It correlates by its `councilRunId` (no `sessionId`), so — like the scan
    // families + `debate-*` — it is routed BEFORE the session-id correlation and consumed
    // INTERNALLY (never forwarded to the web; it rides no `nc:*` channel). The host derives
    // every path from the run id (never an engine-sent path — the escape guard) and replies
    // with a `resolve-worktree-op` command. Offloaded off the reader (git/gauntlet work
    // blocks) via the guarded async spawn, so it never head-of-line-blocks the event stream.
    if event_type == "worktree-op-required" {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            super::council_worktree::handle_worktree_op(&app, event).await;
        });
        return;
    }

    let session_id = event.get("sessionId").and_then(Value::as_u64);

    // Council SEAT carve-out (issue #364). A debate seat session is driven INSIDE the
    // engine by the Conductor — NOT launched via the board's `start_session` command —
    // so it pushed no pending-launch slot in the board-task FIFO. It self-identifies with
    // `council: true` on its `session-started`. For any seat event we must SKIP the FIFO
    // correlation below: `correlate` would otherwise find an empty FIFO and warn (the
    // "correlation desync" flood) or — under concurrent board+council use — POP a
    // still-pending board task's slot and mis-bind the seat to it, poisoning that task's
    // correlation. The seat's output reaches the canvas over the moderated `nc:debate`
    // stream (run-id-keyed, forwarded above), so the raw seat `nc:session` stream is
    // intentionally dropped here. Registered on `session-started`; every later seat event
    // short-circuits on the id set; the terminal deregisters so the set can't grow.
    if let Some(sid) = session_id {
        if is_council_session_start(event_type, &event) {
            provider.note_council_session(sid);
        }
        if provider.is_council_session(sid) {
            if matches!(event_type, "session-completed" | "session-failed") {
                provider.forget(sid);
            }
            return;
        }
    }

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
            // T11: a parked question silently stalls the loop when the window is
            // backgrounded — fire ONE desktop notification (default ON). Body is the
            // task title only; never the model-authored question text (M4.5).
            notify_awaiting_input(app, &task_id);
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
                // T13 (badge honesty): capture the model the engine ACTUALLY resolved
                // for this run (`SessionReadyEvent.model`), so the board badge reflects
                // what ran rather than the requested override (which may be `None` =
                // "inherit the provider default"). Re-stamped on every session start, so
                // a re-run with a different model self-corrects.
                let actual_model = event
                    .get("model")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                apply_and_emit(app, &store, &task_id, |task| {
                    task.session_id = Some(sid);
                    if let Some(ref sdk_id) = sdk_session_id {
                        task.sdk_session_id = Some(sdk_id.clone());
                    }
                    if let Some(ref m) = actual_model {
                        task.actual_model = Some(m.clone());
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

/// Whether `event` is a Council SEAT session's `session-started` (issue #364) — a
/// `session-started` carrying `council: true`. A seat is driven inside the engine by
/// the Conductor, not launched via the board's `start_session` command, so it pushed no
/// pending-launch FIFO slot; the reader records the seat on this event and thereafter
/// skips `correlate` for it (no desync warn, no mis-bind of a concurrently-pending board
/// task). Any non-`session-started` type, or a `session-started` without the flag, is a
/// normal board/scan session (false), so this leaves every non-council path unchanged.
fn is_council_session_start(event_type: &str, event: &Value) -> bool {
    event_type == "session-started" && event.get("council").and_then(Value::as_bool) == Some(true)
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
    use crate::contracts::{trips_breaker_immediately, ErrorCategory};

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
    fn council_session_start_only_matches_a_marked_session_started() {
        // Only a `session-started` carrying `council: true` is a seat (issue #364).
        let seat = json!({
            "type": "session-started", "sessionId": 209, "prompt": "debate",
            "model": "claude-opus-4-8", "permissionMode": "plan", "council": true
        });
        assert!(is_council_session_start("session-started", &seat));

        // A normal board `session-started` (no marker) is NOT a seat — the field is
        // absent, so every non-council launch is left byte-for-byte on the FIFO path.
        let board = json!({
            "type": "session-started", "sessionId": 1, "prompt": "build",
            "model": "claude-opus-4-8", "permissionMode": "default"
        });
        assert!(!is_council_session_start("session-started", &board));

        // An explicit `council: false` is also not a seat.
        let board_false = json!({
            "type": "session-started", "sessionId": 2, "prompt": "build",
            "model": "claude-opus-4-8", "permissionMode": "default", "council": false
        });
        assert!(!is_council_session_start("session-started", &board_false));

        // The marker only means "seat" on `session-started`: a later seat event carries
        // no marker, so it is recognized via the tracked id set, not this predicate.
        let later = json!({ "type": "session-completed", "sessionId": 209, "council": true });
        assert!(
            !is_council_session_start("session-completed", &later),
            "only session-started registers a seat; later events route via the id set"
        );
    }

    #[test]
    fn council_seat_carve_out_precedes_and_bypasses_fifo_correlation() {
        // Structure guard (issue #364): the council-seat carve-out must run BEFORE the
        // board-FIFO `correlate` call, register the seat (`note_council_session`), skip
        // every seat event (`is_council_session` → `return`), and deregister on the
        // terminal (`forget`). This proves a seat never reaches `provider.correlate`
        // (the desync-warn + mis-bind site). The arm needs a full `AppHandle` to run
        // live, so this is a source-level guard like the sibling reader tests.
        let src = include_str!("reader.rs");
        let carve = src
            .find("if is_council_session_start(event_type, &event)")
            .expect("the council carve-out exists");
        let correlate = src
            .find("session_id.and_then(|sid| provider.correlate(sid))")
            .expect("the board-FIFO correlation exists");
        assert!(
            carve < correlate,
            "the council carve-out must run BEFORE the board-FIFO correlation"
        );
        let carve_block = &src[carve..correlate];
        assert!(
            carve_block.contains("provider.note_council_session(sid)"),
            "the carve-out registers a seat on its session-started"
        );
        assert!(
            carve_block.contains("provider.is_council_session(sid)"),
            "the carve-out short-circuits every event for a registered seat"
        );
        assert!(
            carve_block.contains("provider.forget(sid)"),
            "the carve-out deregisters the seat on its terminal"
        );
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

    /// Regression guard (PR #181 review): the sidecar-crash scan reap must emit each
    /// family's EXACT terminal-failure event type. Harness diverges with a `-scan-`
    /// infix (`harness-scan-failed`) while the other four are `<family>-failed`; a
    /// wrong literal silently misses the family handler's `_ => {}` (leaving the run
    /// `running` all session) AND fails the web's event `safeParse`. This validates
    /// every crash-reap const against the codegen'd contract fixtures — an INDEPENDENT
    /// source of truth (the sibling of `generated.rs`), so a hand-typed wrong literal
    /// has no matching fixture and fails HERE even though the same wrong string is used
    /// at both reap sites. Parametrized across all five families so the divergence
    /// can't recur in any of them. (A full store-marking integration test is not
    /// possible in the unit binary — the family handlers are `AppHandle<Wry>`-typed and
    /// `tauri::test` only offers a `MockRuntime` handle; a contract-correct literal is
    /// what transitively guarantees the handler's match arm is hit and the run failed.)
    #[test]
    fn crash_reap_terminal_types_match_the_codegend_contract() {
        // One canonical wire payload per event variant, keyed under "events" by the
        // exact `type` discriminator literal (emitted alongside generated.rs).
        const FIXTURES: &str = include_str!("../contracts/fixtures.json");
        let fixtures: Value = serde_json::from_str(FIXTURES).expect("fixtures.json parses");
        let events = fixtures
            .get("events")
            .and_then(Value::as_object)
            .expect("fixtures.json has an events section");

        let families = [
            ("insight", INSIGHT_CRASH_FAILED_TYPE),
            ("harness", HARNESS_CRASH_FAILED_TYPE),
            ("scorecard", SCORECARD_CRASH_FAILED_TYPE),
            ("pr-review", PR_REVIEW_CRASH_FAILED_TYPE),
            ("issue-triage", ISSUE_VALIDATION_CRASH_FAILED_TYPE),
        ];
        for (family, event_type) in families {
            let fixture = events.get(event_type).unwrap_or_else(|| {
                panic!(
                    "{family}: crash-reap emits {event_type:?}, but the contract declares no \
                     such event — a wrong terminal literal that would miss the handler match \
                     arm and leave the run `running`"
                )
            });
            assert_eq!(
                fixture.get("type").and_then(Value::as_str),
                Some(event_type),
                "{family}: contract fixture {event_type:?} has a mismatched type tag",
            );
        }

        // The family that regressed: it must carry the `-scan-` infix, and the plain
        // `harness-failed` must NOT be a contract event (the exact bug this guards).
        assert_eq!(HARNESS_CRASH_FAILED_TYPE, "harness-scan-failed");
        assert!(
            !events.contains_key("harness-failed"),
            "`harness-failed` is not a contract event — the reap must never emit it"
        );
    }

    #[test]
    fn debate_family_forwards_on_its_channel_before_session_correlation() {
        // The Council `debate-*` family (`debate-entry`) correlates by its wrapped
        // `runId` (no `sessionId`), so it MUST forward onto the `DEBATE_EVENT` channel
        // and `return` BEFORE the session-id correlation below (which would otherwise
        // drop it for lacking a `sessionId`) — mirroring the scan families'
        // pre-correlation routing. The arm needs a full `AppHandle` to exercise live, so
        // this is a source-level guard (like the pr-fix + offload guards above).
        let src = include_str!("reader.rs");
        let arm_at = src
            .find("if event_type.starts_with(\"debate-\")")
            .expect("the debate routing arm exists");
        let emit = src[arm_at..]
            .find("app.emit(DEBATE_EVENT")
            .map(|rel| arm_at + rel)
            .expect("the debate arm forwards on the DEBATE_EVENT channel");
        let correlation = src
            .find("let session_id = event.get(\"sessionId\")")
            .expect("the session-id correlation exists");
        assert!(
            arm_at < correlation && emit < correlation,
            "the debate family must forward + return BEFORE the session-id correlation"
        );
    }
}
