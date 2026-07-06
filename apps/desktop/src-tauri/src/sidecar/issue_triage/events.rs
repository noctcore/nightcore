//! Reader-side handling of the `issue-validation-*` event family: forward each event to
//! the `nc:issue-triage` channel for the live UI and, on the terminal events, finalize or
//! fail the persisted run (idempotent).

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::sidecar::scan::{failure_reason, ScanTelemetry};
use crate::sidecar::ISSUE_TRIAGE_EVENT;
use crate::store::insight::InsightUsage;
use crate::store::issue_triage::{IssueValidationStore, StoredIssueValidationResult};

use super::mark_failed_if_running;

/// Reader-side: forward an `issue-validation-*` event to the `nc:issue-triage` channel
/// and, on the terminal events, finalize/fail the persisted run. Correlates by `runId`
/// (no `sessionId`).
pub(crate) async fn handle_issue_validation_event(
    app: &AppHandle,
    event_type: &str,
    event: &Value,
) {
    // Always forward the raw event so the live panel can stream optimistically.
    let _ = app.emit(ISSUE_TRIAGE_EVENT, event);

    let Some(run_id) = event.get("runId").and_then(Value::as_str) else {
        return;
    };
    let store = app.state::<IssueValidationStore>();

    match event_type {
        "issue-validation-completed" => {
            let Some(result) = event
                .get("result")
                .and_then(StoredIssueValidationResult::from_wire)
            else {
                // A completed event with no parseable verdict must not leave the run
                // spinning `running` forever — fail it with a clear reason.
                tracing::warn!(target: "nightcore", run_id, "issue-validation-completed missing a parseable verdict");
                mark_failed_if_running(&store, run_id, "validation returned no parseable verdict");
                return;
            };
            let tel = ScanTelemetry::from_event(event);
            finalize_validation(&store, run_id, result, &tel);
        }
        "issue-validation-failed" => {
            let reason = failure_reason(event);
            let stamped = mark_failed_if_running(&store, run_id, &reason);
            tracing::info!(target: "nightcore", run_id, reason, stamped, "issue validation ended (failed/aborted)");
        }
        "issue-validation-progress" => {
            let message = event.get("message").and_then(Value::as_str).unwrap_or("");
            tracing::info!(target: "nightcore", run_id, message, "issue validation progress");
        }
        "issue-validation-started" => {
            tracing::info!(target: "nightcore", run_id, "issue validation started (engine)");
        }
        _ => {}
    }
}

/// Finalize a completed validation on its terminal event — idempotently. Under the
/// store's single mutate lock: a run already `completed` WITH a verdict is a no-op (a
/// duplicate terminal must not clobber a user's convert/post edits), else the verdict +
/// telemetry are stamped and `status` becomes `completed`.
pub(super) fn finalize_validation(
    store: &IssueValidationStore,
    run_id: &str,
    result: StoredIssueValidationResult,
    tel: &ScanTelemetry,
) {
    match store.mutate(run_id, move |run| {
        if run.status == "completed" && run.result.is_some() {
            return;
        }
        run.status = "completed".to_string();
        run.result = Some(result);
        run.cost_usd = tel.cost_usd;
        run.duration_ms = tel.duration_ms;
        run.usage = InsightUsage {
            input_tokens: tel.input_tokens,
            output_tokens: tel.output_tokens,
        };
        run.error = None;
    }) {
        Ok(_) => {
            tracing::info!(target: "nightcore", run_id, cost_usd = tel.cost_usd, "issue validation completed")
        }
        Err(e) => {
            tracing::warn!(target: "nightcore", run_id, error = %e, "failed to finalize issue validation")
        }
    }
}
