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

use tauri::{AppHandle, Emitter, State};

use crate::contracts::{ConventionCategory, EffortLevel, SurfaceCommand};
use crate::project::ProjectStore;
use crate::sidecar::scan::{
    begin_scan_run, dispatch_scan_command, scan_lifecycle_commands, untrusted_block, wire_str,
    ScanRunInit,
};
use crate::sidecar::HARNESS_EVENT;
use crate::store::harness::{
    ApplyOutcome, HarnessRun, HarnessStore, HarnessUsage, LinkOutcome, StoredConventionFinding,
    StoredRepoProfile,
};
use crate::store::TaskStore;
use crate::task::{Task, TaskKind, TASK_EVENT};

use super::apply::{safe_join, write_create, write_merge_manifest, write_merge_section};

/// The check kinds the Structure-Lock gauntlet knows how to run (mirrors
/// `workflow::gauntlet_project::HarnessCheckKind`). Arming is restricted to these so a
/// stray kind can't land an entry the gauntlet will only warn-and-skip.
const ARMABLE_CHECK_KINDS: &[&str] = &["lint-plugin", "dependency-cruiser", "coverage-threshold"];

// The four store-agnostic lifecycle commands (list / get / delete / cancel), stamped
// from the shared scan macro instead of hand-copied per feature.
scan_lifecycle_commands! {
    store: HarnessStore,
    run: HarnessRun,
    list: list_harness_runs,
    get: get_harness_run,
    delete: delete_harness_run,
    cancel: cancel_harness_scan,
    cancel_command: CancelHarnessScan,
    item: "harness",
}

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
        proposals: Vec::new(),
        synthesizing: false,
        error: None,
    };
    // Single-flight: reject a second concurrent scan for this project.
    harness_store.upsert_if_idle(
        &run,
        "a harness scan is already running for this project — wait for it to finish or cancel it first",
    )?;

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

/// Dismiss a convention finding (it stays dismissed across future re-scans).
#[tauri::command]
pub fn dismiss_harness_finding(
    harness_store: State<'_, HarnessStore>,
    run_id: String,
    finding_id: String,
) -> Result<HarnessRun, String> {
    harness_store.set_finding_status(&run_id, &finding_id, "dismissed", None)
}

/// Restore a dismissed convention finding back to open.
#[tauri::command]
pub fn restore_harness_finding(
    harness_store: State<'_, HarnessStore>,
    run_id: String,
    finding_id: String,
) -> Result<HarnessRun, String> {
    harness_store.set_finding_status(&run_id, &finding_id, "open", None)
}

/// Convert a convention finding into a board task. Idempotent: if the finding already
/// links to a live task, that task is returned instead of minting a duplicate. Every
/// finding becomes a `build` task (the kind that edits + verifies); the finding's
/// model-derived text is fenced as untrusted in the description. Emits the task event and
/// a `finding-converted` notice so the open Harness view updates in place. Mirrors
/// Insight's `convert_finding_to_task` (same mint-first / atomic-CAS / rollback protocol).
#[tauri::command]
pub fn convert_harness_finding_to_task(
    app: AppHandle,
    store: State<'_, TaskStore>,
    harness_store: State<'_, HarnessStore>,
    run_id: String,
    finding_id: String,
) -> Result<Task, String> {
    let finding = harness_store
        .get_finding(&run_id, &finding_id)
        .ok_or_else(|| format!("finding {finding_id} not found in run {run_id}"))?;

    // Fast-path idempotency: a finding already linked to a still-existing task returns
    // it without minting anything (covers the common re-click).
    if let Some(existing_id) = finding.linked_task_id.as_deref() {
        if let Some(task) = store.get(existing_id) {
            return Ok(task);
        }
    }

    // Mint the task FIRST (so a crash before linking leaves an unlinked finding —
    // retryable — rather than a finding pointing at a non-existent task), then link
    // ATOMICALLY. The compare-and-set inside `link_finding_task` is the real guard
    // against two concurrent converts: a losing race gets `AlreadyLinked` and we roll
    // back the duplicate task we just created.
    let mut task = Task::new(finding.title.clone(), convention_task_description(&finding));
    task.kind = TaskKind::Build;
    // upsert returns the store-stamped task (seq > 0); we MUST emit this snapshot, not
    // `task`, so the wire carries the assigned seq and is never dropped as stale.
    let stamped = store.upsert(&task)?;

    match harness_store.link_finding_task(&run_id, &finding_id, &task.id) {
        Ok(LinkOutcome::Linked) => {}
        Ok(LinkOutcome::AlreadyLinked(existing_id)) => {
            // Another convert won the race (or a prior link survived). Discard the
            // duplicate task we just minted and return the existing one if it lives.
            let _ = store.remove(&task.id);
            if let Some(existing) = store.get(&existing_id) {
                return Ok(existing);
            }
            // The linked task was deleted out from under us: re-point the finding at the
            // task we just (re)created instead of leaving a dangling link.
            store.upsert(&task)?;
            harness_store.set_finding_status(
                &run_id,
                &finding_id,
                "converted",
                Some(Some(task.id.clone())),
            )?;
        }
        Err(e) => {
            // Linking failed (run/finding vanished): roll back the orphan task so a retry
            // is clean rather than leaving an unlinked board task behind.
            let _ = store.remove(&task.id);
            return Err(e);
        }
    }

    let _ = app.emit(TASK_EVENT, &stamped);
    let _ = app.emit(
        HARNESS_EVENT,
        json!({
            "type": "finding-converted",
            "runId": run_id,
            "findingId": finding_id,
            "taskId": stamped.id,
        }),
    );
    tracing::info!(target: "nightcore", task_id = %stamped.id, finding_id = %finding_id, "harness finding converted to task");
    Ok(stamped)
}

/// Build the markdown task description from a convention finding's fields + provenance.
/// The model-derived body is wrapped in an [`untrusted_block`] so the write-capable Build
/// agent treats it as data, not instructions (prompt-injection mitigation); only the
/// trusted provenance footer sits outside the fence.
fn convention_task_description(f: &StoredConventionFinding) -> String {
    let mut body = String::new();
    body.push_str(&f.description);
    body.push_str("\n\n");
    body.push_str(&format!(
        "**Lens:** {} · **Kind:** {} · **Severity:** {}\n",
        f.category, f.kind, f.severity
    ));
    if let Some(r) = &f.rationale {
        body.push_str(&format!("\n**Why it matters:** {r}\n"));
    }
    if let Some(s) = &f.suggestion {
        let heading = if f.kind == "gap" {
            "Change to adopt"
        } else {
            "Rule to codify"
        };
        body.push_str(&format!("\n**{heading}:** {s}\n"));
    }
    if !f.evidence.is_empty() {
        body.push_str("\n**Evidence:**\n");
        for e in &f.evidence {
            let lines = match (e.start_line, e.end_line) {
                (Some(s), Some(end)) if end != s => format!(":{s}-{end}"),
                (Some(s), _) => format!(":{s}"),
                _ => String::new(),
            };
            body.push_str(&format!("- `{}{}`\n", e.file, lines));
        }
    }
    if !f.tags.is_empty() {
        body.push_str(&format!("\n**Tags:** {}\n", f.tags.join(", ")));
    }
    let mut out = untrusted_block(&body);
    out.push_str("\n---\n_Created from a Harness convention finding._\n");
    out
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

/// Arm (or re-arm) a Structure-Lock gauntlet check in the scanned project's
/// `.nightcore/harness.json`. THIS is the writer that closes the spec's Harden→Lock arrow:
/// until now the gauntlet ([`crate::workflow::gauntlet_project`]) had consumers but no
/// producer, so it ran zero checks for every real user. The check `command` is supplied
/// by the trusted UI on an explicit user action — the human gate the redesign calls for —
/// never derived from synthesis output (a guessed command would either be a false-positive
/// gate or, worse, injected code the gauntlet would then execute under every reviewer). The
/// destination is hard-pinned to `.nightcore/harness.json` in [`write_merge_manifest`] and
/// merged by check `name` (idempotent + re-armable), so hand-authored checks are preserved.
#[tauri::command]
pub fn arm_harness_gauntlet_check(
    app: AppHandle,
    harness_store: State<'_, HarnessStore>,
    run_id: String,
    name: String,
    kind: String,
    command: String,
) -> Result<(), String> {
    let name = name.trim();
    let command = command.trim();
    if name.is_empty() {
        return Err("a gauntlet check needs a name".to_string());
    }
    if command.is_empty() {
        return Err("a gauntlet check needs a command to run".to_string());
    }
    if !ARMABLE_CHECK_KINDS.contains(&kind.as_str()) {
        return Err(format!(
            "unknown check kind `{kind}` — expected one of: {}",
            ARMABLE_CHECK_KINDS.join(", ")
        ));
    }
    let run = harness_store
        .get(&run_id)
        .ok_or_else(|| format!("no harness run with id {run_id}"))?;

    // The entry is built HERE, in Rust, from validated inputs — the manifest is never
    // handed a model-authored object. `enabled: true` so a freshly-armed check is live.
    let entry = json!({
        "name": name,
        "kind": kind,
        "command": command,
        "enabled": true,
    });
    let dest = write_merge_manifest(Path::new(&run.project_path), &entry).map_err(|e| {
        tracing::warn!(target: "nightcore", run_id = %run_id, name = %name, error = %e, "arming gauntlet check failed");
        e
    })?;

    let _ = app.emit(
        HARNESS_EVENT,
        json!({
            "type": "check-armed",
            "runId": run_id,
            "name": name,
            "kind": kind,
        }),
    );
    tracing::info!(target: "nightcore", run_id = %run_id, name = %name, kind = %kind, path = %dest.display(), "structure-lock check armed in harness.json");
    Ok(())
}
