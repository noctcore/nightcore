//! The Harness (codebase convention auditor) `#[tauri::command]` handlers (web → Rust).
//!
//! `start_harness_scan` dispatches a `start-harness-scan` `SurfaceCommand` to the sidecar
//! (whose `SessionManager` detects the repo profile, fans out the read-only convention
//! passes, then synthesizes proposed artifacts) and creates the persisted run;
//! `cancel_harness_scan` aborts it; the rest are store reads/mutations PLUS the one
//! write-bearing command, `apply_harness_artifact`, which writes a proposed artifact into
//! the TARGET REPO. That write is the only place this feature touches a user's files, so
//! it is defended hard by the [`apply`](super::apply) module: the destination must resolve
//! inside the project root, `create` never clobbers an existing file, and doc artifacts
//! merge into a delimited managed block.

use serde_json::json;
use std::path::Path;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::contracts::{ConventionCategory, EffortLevel, SurfaceCommand};
use crate::provider::SidecarProvider;
use crate::project::ProjectStore;
use crate::sidecar::scan::{begin_scan_run, dispatch_scan_command, wire_str, ScanRunInit};
use crate::sidecar::HARNESS_EVENT;
use crate::store::harness::{
    ApplyOutcome, HarnessRun, HarnessStore, HarnessUsage, StoredRepoProfile,
};

use super::apply::{safe_join, write_create, write_merge_section};

/// Start a Harness scan over the active project. Creates the persisted run (status
/// `running`), dispatches the `start-harness-scan` command, and returns the `runId` the
/// `harness-*` events correlate by.
#[tauri::command]
pub async fn start_harness_scan(
    app: AppHandle,
    projects: State<'_, ProjectStore>,
    harness_store: State<'_, HarnessStore>,
    categories: Vec<ConventionCategory>,
    model: Option<String>,
    effort: Option<EffortLevel>,
) -> Result<String, String> {
    let ScanRunInit {
        project_path,
        run_id,
        model: model_str,
        now,
    } = begin_scan_run(
        projects.active(),
        categories.is_empty(),
        "select at least one convention lens to scan",
        "no active project to scan",
        model.as_deref(),
    )?;
    let category_strs: Vec<String> = categories.iter().map(wire_str).collect();

    // Persist the run as `running` up front so it shows immediately in the list.
    let run = HarnessRun {
        id: run_id.clone(),
        project_path: project_path.clone(),
        status: "running".to_string(),
        categories: category_strs,
        model: model_str,
        created_at: now,
        updated_at: now,
        cost_usd: 0.0,
        duration_ms: 0,
        usage: HarnessUsage::default(),
        profile: StoredRepoProfile::default(),
        findings: Vec::new(),
        artifacts: Vec::new(),
        synthesizing: false,
        error: None,
    };
    harness_store.upsert(&run)?;

    // Ensure the sidecar is up, then dispatch the scan command; on failure the
    // shared helper persists the run's failed-state (so it doesn't look stuck).
    let command = SurfaceCommand::StartHarnessScan {
        run_id: run_id.clone(),
        project_path,
        categories,
        model,
        effort,
        max_concurrency: None,
        max_turns_per_category: None,
        max_budget_usd_per_category: None,
    };
    dispatch_scan_command(&app, "harness", &run_id, command, |msg| {
        harness_store
            .mutate(&run_id, |r| {
                r.status = "failed".to_string();
                r.error = Some(msg.to_string());
            })
            .map(|_| ())
    })
    .await?;

    tracing::info!(target: "nightcore", run_id = %run_id, "harness scan started");
    Ok(run_id)
}

/// Cancel an in-flight scan (aborts every convention pass + synthesis).
#[tauri::command]
pub async fn cancel_harness_scan(app: AppHandle, run_id: String) -> Result<(), String> {
    let provider = app.state::<std::sync::Arc<SidecarProvider>>();
    let command = SurfaceCommand::CancelHarnessScan {
        run_id: run_id.clone(),
    };
    provider.dispatch_command(command).await
}

/// All harness scans for the active project (newest first).
#[tauri::command]
pub fn list_harness_runs(harness_store: State<'_, HarnessStore>) -> Result<Vec<HarnessRun>, String> {
    Ok(harness_store.list())
}

/// One harness scan by id.
#[tauri::command]
pub fn get_harness_run(
    harness_store: State<'_, HarnessStore>,
    run_id: String,
) -> Result<Option<HarnessRun>, String> {
    Ok(harness_store.get(&run_id))
}

/// Delete a harness scan and its file.
#[tauri::command]
pub fn delete_harness_run(
    harness_store: State<'_, HarnessStore>,
    run_id: String,
) -> Result<(), String> {
    harness_store.remove(&run_id)
}

/// Dismiss a convention finding (it stays dismissed across future re-scans).
#[tauri::command]
pub fn dismiss_harness_finding(
    harness_store: State<'_, HarnessStore>,
    run_id: String,
    finding_id: String,
) -> Result<HarnessRun, String> {
    harness_store.set_finding_status(&run_id, &finding_id, "dismissed")
}

/// Restore a dismissed convention finding back to open.
#[tauri::command]
pub fn restore_harness_finding(
    harness_store: State<'_, HarnessStore>,
    run_id: String,
    finding_id: String,
) -> Result<HarnessRun, String> {
    harness_store.set_finding_status(&run_id, &finding_id, "open")
}

/// Dismiss a proposed artifact (hidden from the proposed-harness panel; stays dismissed
/// across re-scans by fingerprint).
#[tauri::command]
pub fn dismiss_harness_artifact(
    harness_store: State<'_, HarnessStore>,
    run_id: String,
    artifact_id: String,
) -> Result<HarnessRun, String> {
    harness_store.set_artifact_status(&run_id, &artifact_id, "dismissed")
}

/// Restore a dismissed artifact back to proposed.
#[tauri::command]
pub fn restore_harness_artifact(
    harness_store: State<'_, HarnessStore>,
    run_id: String,
    artifact_id: String,
) -> Result<HarnessRun, String> {
    harness_store.set_artifact_status(&run_id, &artifact_id, "proposed")
}

/// Apply a proposed artifact: WRITE it into the target repo and mark it applied. This is
/// the only command that mutates a user's files, so the destination is validated against
/// the project root before any write. `create` artifacts never overwrite an existing file
/// (`create_new`); `merge-section` artifacts replace a delimited managed block (creating
/// the file if absent), leaving the user's surrounding content untouched.
#[tauri::command]
pub fn apply_harness_artifact(
    app: AppHandle,
    harness_store: State<'_, HarnessStore>,
    run_id: String,
    artifact_id: String,
) -> Result<HarnessRun, String> {
    let run = harness_store
        .get(&run_id)
        .ok_or_else(|| format!("no harness run with id {run_id}"))?;
    let artifact = harness_store
        .get_artifact(&run_id, &artifact_id)
        .ok_or_else(|| format!("artifact {artifact_id} not found in run {run_id}"))?;

    // Idempotent: an already-applied artifact returns the run without re-writing.
    if artifact.status == "applied" {
        return Ok(run);
    }

    // Resolve + contain the destination inside the project root the scan ran against.
    // A rejection here is a security-relevant event (a proposed artifact resolved
    // outside the repo / through a symlink) — log it, don't just bubble silently.
    let dest = safe_join(Path::new(&run.project_path), &artifact.target_path).map_err(|e| {
        tracing::warn!(target: "nightcore", run_id = %run_id, artifact_id = %artifact_id, path = %artifact.target_path, error = %e, "harness artifact path rejected (containment)");
        e
    })?;

    let write_result = match artifact.write_mode.as_str() {
        "create" => write_create(&dest, &artifact.content),
        "merge-section" => write_merge_section(&dest, &artifact.content),
        other => return Err(format!("unknown artifact writeMode: {other}")),
    };
    if let Err(e) = write_result {
        // `create` refuses to clobber. If a concurrent apply — or a prior apply whose
        // source run was pruned past MAX_RUNS — already wrote AND committed this
        // artifact, the file existing is idempotent SUCCESS, not a failure (mirror the
        // proven convert-to-task idempotent-loser path). Only a file that exists for an
        // unrelated reason (the user's own file) surfaces the clobber error.
        if artifact.write_mode == "create" {
            if let Some(current) = harness_store.get_artifact(&run_id, &artifact_id) {
                if current.status == "applied" {
                    return Ok(harness_store.get(&run_id).unwrap_or(run));
                }
            }
        }
        tracing::warn!(target: "nightcore", run_id = %run_id, artifact_id = %artifact_id, path = %artifact.target_path, write_mode = %artifact.write_mode, error = %e, "harness artifact write failed");
        return Err(e);
    }

    // Record the applied status atomically. A failure HERE is the worst case — the file
    // is already on disk but its lifecycle is uncommitted — so it gets its own log.
    let (outcome, updated) = harness_store
        .mark_artifact_applied(&run_id, &artifact_id, &artifact.target_path)
        .map_err(|e| {
            tracing::error!(target: "nightcore", run_id = %run_id, artifact_id = %artifact_id, path = %artifact.target_path, error = %e, "harness artifact written but applied-status not committed");
            e
        })?;
    if let ApplyOutcome::AlreadyApplied(path) = &outcome {
        // A concurrent apply won the status race after our write; the file is on disk
        // either way. Log and return the up-to-date run rather than erroring.
        tracing::debug!(target: "nightcore", run_id = %run_id, artifact_id = %artifact_id, path = %path, "artifact already applied by a concurrent request");
    }

    let _ = app.emit(
        HARNESS_EVENT,
        json!({
            "type": "artifact-applied",
            "runId": run_id,
            "artifactId": artifact_id,
            "path": artifact.target_path,
        }),
    );
    tracing::info!(target: "nightcore", run_id = %run_id, artifact_id = %artifact_id, path = %artifact.target_path, "harness artifact applied");
    Ok(updated)
}
