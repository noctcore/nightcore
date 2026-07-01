//! Reader-side handling of the `harness-*` event family (sidecar → Rust).
//!
//! [`handle_harness_event`] forwards every `harness-*` event to the `nc:harness` channel
//! and, on `harness-scan-completed`, finalizes the persisted run — carrying dismissed
//! findings and applied/dismissed artifacts forward by fingerprint so a re-scan doesn't
//! reset the user's lifecycle edits. Intermediate lifecycle events stream for the live UI
//! and are logged here so a long scan's progress reaches the terminal.

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::sidecar::scan::{failure_reason, finalize_completed, ScanTelemetry};
use crate::sidecar::HARNESS_EVENT;
use crate::store::harness::{
    HarnessStore, StoredConventionFinding, StoredProposedArtifact, StoredRepoProfile,
};

/// Reader-side: forward a `harness-*` event to the `nc:harness` channel and, on the
/// terminal events, finalize/fail the persisted run. Intermediate events stream for the
/// live UI; persistence happens on `harness-scan-completed` (authoritative).
pub(crate) async fn handle_harness_event(app: &AppHandle, event_type: &str, event: &Value) {
    // Always forward the raw event so the live panel can stream optimistically.
    let _ = app.emit(HARNESS_EVENT, event);

    let Some(run_id) = event.get("runId").and_then(Value::as_str) else {
        return;
    };
    let harness_store = app.state::<HarnessStore>();

    match event_type {
        "harness-scan-completed" => {
            let profile = event
                .get("profile")
                .map(StoredRepoProfile::from_wire)
                .unwrap_or_default();

            let mut findings: Vec<StoredConventionFinding> = event
                .get("findings")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(StoredConventionFinding::from_wire)
                        .collect()
                })
                .unwrap_or_default();
            // Dismissed-history reconciliation for findings (cross-run, by fingerprint).
            let dismissed = harness_store.dismissed_finding_fingerprints(Some(run_id));
            for f in &mut findings {
                if dismissed.contains(&f.fingerprint) {
                    f.status = "dismissed".to_string();
                }
            }

            let mut artifacts: Vec<StoredProposedArtifact> = event
                .get("artifacts")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(StoredProposedArtifact::from_wire)
                        .collect()
                })
                .unwrap_or_default();
            // Carry applied/dismissed artifacts forward by fingerprint so a re-scan
            // doesn't re-propose a harness piece the user already wrote or rejected.
            let prior_artifacts = harness_store.prior_artifact_states(Some(run_id));
            for a in &mut artifacts {
                if let Some(carry) = prior_artifacts.get(&a.fingerprint) {
                    a.status = carry.status.clone();
                    a.applied_path = carry.applied_path.clone();
                    a.applied_at = carry.applied_at;
                }
            }

            let tel = ScanTelemetry::from_event(event);
            let (finding_count, artifact_count) = (findings.len(), artifacts.len());

            // The shared finalizer owns the idempotency guard + status/telemetry stamp; we
            // inject the harness-specific merge: in-run finding/artifact lifecycle
            // carry-forward plus the profile + cleared synthesizing flag.
            let finalized =
                finalize_completed(harness_store.inner(), "harness", run_id, &tel, move |run| {
                    // Carry IN-RUN finding lifecycle (dismissed live during this scan).
                    let prior_findings: std::collections::HashMap<String, String> = run
                        .findings
                        .iter()
                        .filter(|f| f.status != "open")
                        .map(|f| (f.fingerprint.clone(), f.status.clone()))
                        .collect();
                    let mut merged_findings = findings;
                    for f in &mut merged_findings {
                        if let Some(status) = prior_findings.get(&f.fingerprint) {
                            f.status = status.clone();
                        }
                    }
                    // Carry IN-RUN artifact lifecycle (applied/dismissed live during this
                    // scan), preserving applied_path AND applied_at so a re-finalize never
                    // nulls the apply timestamp.
                    type InRun = (String, Option<String>, Option<u64>);
                    let prior_in_run: std::collections::HashMap<String, InRun> = run
                        .artifacts
                        .iter()
                        .filter(|a| a.status != "proposed")
                        .map(|a| {
                            (
                                a.fingerprint.clone(),
                                (a.status.clone(), a.applied_path.clone(), a.applied_at),
                            )
                        })
                        .collect();
                    let mut merged_artifacts = artifacts;
                    for a in &mut merged_artifacts {
                        if let Some((status, path, at)) = prior_in_run.get(&a.fingerprint) {
                            a.status = status.clone();
                            a.applied_path = path.clone();
                            a.applied_at = *at;
                        }
                    }

                    run.profile = profile;
                    run.findings = merged_findings;
                    run.artifacts = merged_artifacts;
                    run.synthesizing = false;
                });
            if finalized {
                tracing::info!(target: "nightcore", run_id, findings = finding_count, artifacts = artifact_count, cost_usd = tel.cost_usd, "harness scan completed");
            }
        }
        "harness-scan-failed" => {
            let reason = failure_reason(event);
            let _ = harness_store.mutate(run_id, |run| {
                run.status = "failed".to_string();
                run.synthesizing = false;
                run.error = Some(reason.clone());
            });
            tracing::info!(target: "nightcore", run_id, reason, "harness scan ended (failed/aborted)");
        }
        // Intermediate lifecycle events: forwarded above for the live UI, and logged
        // here (mirroring reader.rs's session logging) so a long scan's progress reaches
        // the terminal instead of going silent between the two endpoints.
        "harness-profile-ready" => {
            let profile = event.get("profile");
            let is_monorepo = profile
                .and_then(|p| p.get("isMonorepo"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let workspace_tool = profile
                .and_then(|p| p.get("workspaceTool"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let packages = profile
                .and_then(|p| p.get("packages"))
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            tracing::info!(target: "nightcore", run_id, is_monorepo, workspace_tool, packages, "harness profile ready");
        }
        "harness-category-started" => {
            let category = event
                .get("category")
                .and_then(Value::as_str)
                .unwrap_or("");
            tracing::info!(target: "nightcore", run_id, category, "harness lens started");
        }
        "harness-category-completed" => {
            let category = event
                .get("category")
                .and_then(Value::as_str)
                .unwrap_or("");
            let findings = event
                .get("findings")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            let cost = event.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0);
            tracing::info!(target: "nightcore", run_id, category, findings, cost_usd = cost, "harness lens completed");
        }
        "harness-synthesis-started" => {
            // Persist the synthesizing flag so a reload during the (serial,
            // multi-minute) synthesis tail still projects the "Synthesizing…"
            // state instead of the all-lenses-done dead zone.
            let _ = harness_store.mutate(run_id, |run| run.synthesizing = true);
            tracing::info!(target: "nightcore", run_id, "harness synthesis started");
        }
        "harness-proposals-ready" => {
            let artifacts = event
                .get("artifacts")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            // Synthesis produced its proposals: clear the flag (mirrors the live fold).
            let _ = harness_store.mutate(run_id, |run| run.synthesizing = false);
            tracing::info!(target: "nightcore", run_id, artifacts, "harness proposals ready");
        }
        _ => {}
    }
}
