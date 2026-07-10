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
    begin_scan_run, dispatch_scan_command, scan_lifecycle_commands, wire_str, ScanRunInit,
};
use crate::sidecar::HARNESS_EVENT;
use crate::store::harness::{
    ApplyOutcome, HarnessRun, HarnessStore, HarnessUsage, StoredProposedArtifact, StoredRepoProfile,
};

use super::apply::{safe_join, write_create, write_merge_manifest, write_merge_section};

/// The check kinds the Structure-Lock gauntlet knows how to run (kept in lockstep with
/// `workflow::gauntlet_project::HarnessCheckKind`). Arming is restricted to these so a
/// stray kind can't land an entry the gauntlet will only warn-and-skip. Beyond the three
/// original gauntlet kinds, the rest are the hardening-catalog producers: `lockfile-lint`
/// (#11 dependency firewall), `env-contract` (#13 env-var contract), `secret-scan`
/// (#4 secret hygiene), `mutation-score` (#17 mutation audit), `ast-grep` (#18 policy
/// pack), `api-extractor` (#18 API surface lock).
const ARMABLE_CHECK_KINDS: &[&str] = &[
    "lint-plugin",
    "dependency-cruiser",
    "coverage-threshold",
    "lockfile-lint",
    "env-contract",
    "secret-scan",
    "mutation-score",
    "ast-grep",
    "api-extractor",
];

/// Validate a requested gauntlet-check kind against the armable allowlist. Factored out
/// of [`arm_harness_gauntlet_check`] so the security-relevant gate — a stray or injected
/// kind must never land a manifest entry the gauntlet will only warn-and-skip — is
/// unit-testable without Tauri state. Matching is exact and case-sensitive: kinds are
/// kebab-case wire strings, and accepting a near-miss would arm a check that never runs.
fn validate_armable_check_kind(kind: &str) -> Result<(), String> {
    if !ARMABLE_CHECK_KINDS.contains(&kind) {
        return Err(format!(
            "unknown check kind `{kind}` — expected one of: {}",
            ARMABLE_CHECK_KINDS.join(", ")
        ));
    }
    Ok(())
}

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
    provider_id: Option<String>,
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
        coverage: Vec::new(),
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
        provider_id,
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

/// Dismiss a task-shaped proposal (hidden from the proposals panel; stays dismissed
/// across future re-scans by fingerprint).
#[tauri::command]
pub fn dismiss_harness_proposal(
    harness_store: State<'_, HarnessStore>,
    run_id: String,
    proposal_id: String,
) -> Result<HarnessRun, String> {
    harness_store.set_proposal_status(&run_id, &proposal_id, "dismissed", None)
}

/// Restore a dismissed proposal back to proposed.
#[tauri::command]
pub fn restore_harness_proposal(
    harness_store: State<'_, HarnessStore>,
    run_id: String,
    proposal_id: String,
) -> Result<HarnessRun, String> {
    harness_store.set_proposal_status(&run_id, &proposal_id, "proposed", None)
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
/// the file if absent), leaving the user's surrounding content untouched. The defended
/// file writes run on the blocking pool — never on the UI thread; concurrency is already
/// serialized by the store's locked mutations + the per-artifact idempotent apply, so no
/// extra single-flight guard is needed.
#[tauri::command]
pub async fn apply_harness_artifact(
    app: AppHandle,
    run_id: String,
    artifact_id: String,
) -> Result<HarnessRun, String> {
    tauri::async_runtime::spawn_blocking(move || {
        apply_harness_artifact_blocking(&app, &run_id, &artifact_id)
    })
    .await
    .map_err(|e| format!("apply harness artifact failed to run: {e}"))?
}

/// The blocking body of `apply_harness_artifact`, run off the UI thread. Managed state is
/// re-acquired from the owned `AppHandle` (`try_state` so an unmanaged store fails
/// gracefully); the write path itself ([`apply_one_artifact`] → `apply.rs`) is unchanged.
fn apply_harness_artifact_blocking(
    app: &AppHandle,
    run_id: &str,
    artifact_id: &str,
) -> Result<HarnessRun, String> {
    use tauri::Manager;
    let harness_store = app
        .try_state::<HarnessStore>()
        .ok_or_else(|| "harness store unavailable".to_string())?;
    let run = harness_store
        .get(run_id)
        .ok_or_else(|| format!("no harness run with id {run_id}"))?;
    let artifact = harness_store
        .get_artifact(run_id, artifact_id)
        .ok_or_else(|| format!("artifact {artifact_id} not found in run {run_id}"))?;

    apply_one_artifact(app, &harness_store, run_id, &run.project_path, &artifact)?;
    // Return the up-to-date run (the write above may have flipped this or a concurrent
    // artifact's status); fall back to the pre-apply snapshot only if the run vanished.
    Ok(harness_store.get(run_id).unwrap_or(run))
}

/// Write ONE proposed artifact into the target repo and commit its `applied` status,
/// emitting `artifact-applied` on success. Shared by [`apply_harness_artifact`] (one
/// artifact) and [`apply_harness_proposal`] (a whole `apply-artifacts` bundle). This is the
/// only place the feature mutates a user's files, so the destination is resolved + contained
/// inside `project_path` before any write. Idempotent: an already-`applied` artifact — or
/// one whose file a concurrent / pruned apply already wrote + committed — is treated as
/// success without re-writing (mirrors the proven convert-to-task idempotent-loser path).
fn apply_one_artifact(
    app: &AppHandle,
    harness_store: &HarnessStore,
    run_id: &str,
    project_path: &str,
    artifact: &StoredProposedArtifact,
) -> Result<(), String> {
    let artifact_id = &artifact.id;

    // Idempotent: an already-applied artifact needs no re-write.
    if artifact.status == "applied" {
        return Ok(());
    }

    // Resolve + contain the destination inside the project root the scan ran against.
    // A rejection here is a security-relevant event (a proposed artifact resolved
    // outside the repo / through a symlink) — log it, don't just bubble silently.
    let dest = safe_join(Path::new(project_path), &artifact.target_path).map_err(|e| {
        tracing::warn!(target: "nightcore", run_id = %run_id, artifact_id = %artifact_id, path = %artifact.target_path, error = %e, "harness artifact path rejected (containment)");
        e
    })?;

    let write_result = match artifact.write_mode.as_str() {
        "create" => write_create(Path::new(project_path), &dest, &artifact.content),
        "merge-section" => write_merge_section(Path::new(project_path), &dest, &artifact.content),
        other => return Err(format!("unknown artifact writeMode: {other}")),
    };
    if let Err(e) = write_result {
        // `create` refuses to clobber. If a concurrent apply — or a prior apply whose
        // source run was pruned past MAX_RUNS — already wrote AND committed this
        // artifact, the file existing is idempotent SUCCESS, not a failure. Only a file
        // that exists for an unrelated reason (the user's own file) surfaces the error.
        if artifact.write_mode == "create" {
            if let Some(current) = harness_store.get_artifact(run_id, artifact_id) {
                if current.status == "applied" {
                    return Ok(());
                }
            }
        }
        tracing::warn!(target: "nightcore", run_id = %run_id, artifact_id = %artifact_id, path = %artifact.target_path, write_mode = %artifact.write_mode, error = %e, "harness artifact write failed");
        return Err(e);
    }

    // Record the applied status atomically. A failure HERE is the worst case — the file
    // is already on disk but its lifecycle is uncommitted — so it gets its own log.
    let (outcome, _) = harness_store
        .mark_artifact_applied(run_id, artifact_id, &artifact.target_path)
        .map_err(|e| {
            tracing::error!(target: "nightcore", run_id = %run_id, artifact_id = %artifact_id, path = %artifact.target_path, error = %e, "harness artifact written but applied-status not committed");
            e
        })?;
    if let ApplyOutcome::AlreadyApplied(path) = &outcome {
        // A concurrent apply won the status race after our write; the file is on disk
        // either way. Log and treat as success rather than erroring.
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
    Ok(())
}

/// Apply an `apply-artifacts` proposal as a BUNDLE: write every artifact it references into
/// the target repo (each through the same hardened, path-contained per-artifact writer as
/// [`apply_harness_artifact`]), then mark the proposal `applied`. This is the deterministic
/// half of the Harness-v2 propose-then-convert split — safe file artifacts land directly on
/// the hardened `apply.rs` path with no agent + no cost, while execution-adjacent work stays
/// an `agent-task` proposal you convert to a board task.
///
/// Idempotent per artifact (already-applied ones are skipped) and partial-failure-aware: if
/// an artifact fails to write, the ones that already succeeded stay applied, the proposal is
/// NOT marked applied, and the first failure is returned so the user can fix + retry (the
/// retry re-runs cleanly — succeeded artifacts short-circuit). An `agent-task` proposal has
/// no artifacts to write and is rejected (convert it to a board task instead).
#[tauri::command]
pub async fn apply_harness_proposal(
    app: AppHandle,
    run_id: String,
    proposal_id: String,
) -> Result<HarnessRun, String> {
    // A bundle is N defended file writes — run it on the blocking pool like the
    // single-artifact apply; the same store-level serialization covers it.
    tauri::async_runtime::spawn_blocking(move || {
        apply_harness_proposal_blocking(&app, &run_id, &proposal_id)
    })
    .await
    .map_err(|e| format!("apply harness proposal failed to run: {e}"))?
}

/// The blocking body of `apply_harness_proposal`, run off the UI thread. Managed state
/// is re-acquired from the owned `AppHandle` (`try_state` so an unmanaged store fails
/// gracefully); the per-artifact write path is unchanged.
fn apply_harness_proposal_blocking(
    app: &AppHandle,
    run_id: &str,
    proposal_id: &str,
) -> Result<HarnessRun, String> {
    use tauri::Manager;
    let harness_store = app
        .try_state::<HarnessStore>()
        .ok_or_else(|| "harness store unavailable".to_string())?;
    let run = harness_store
        .get(run_id)
        .ok_or_else(|| format!("no harness run with id {run_id}"))?;
    let proposal = harness_store
        .get_proposal(run_id, proposal_id)
        .ok_or_else(|| format!("proposal {proposal_id} not found in run {run_id}"))?;

    if proposal.kind != "apply-artifacts" {
        return Err(format!(
            "proposal {proposal_id} is an agent task with no artifacts to apply — convert it to a board task instead"
        ));
    }
    if proposal.artifact_ids.is_empty() {
        return Err(format!(
            "proposal {proposal_id} references no artifacts to apply"
        ));
    }

    // Apply each referenced artifact through the shared hardened writer. An id that no
    // longer resolves (its artifact was pruned / edited out of a re-scan) is skipped with a
    // warn rather than aborting the whole bundle.
    let mut applied = 0usize;
    for artifact_id in &proposal.artifact_ids {
        let Some(artifact) = harness_store.get_artifact(run_id, artifact_id) else {
            tracing::warn!(target: "nightcore", run_id = %run_id, proposal_id = %proposal_id, artifact_id = %artifact_id, "proposal references an unknown artifact; skipping");
            continue;
        };
        apply_one_artifact(app, &harness_store, run_id, &run.project_path, &artifact)?;
        applied += 1;
    }

    // Every referenced artifact is on disk → mark the proposal applied (an unconditional
    // overwrite; re-applying is idempotent). The link field is left untouched.
    let updated = harness_store.set_proposal_status(run_id, proposal_id, "applied", None)?;
    let _ = app.emit(
        HARNESS_EVENT,
        json!({
            "type": "proposal-applied",
            "runId": run_id,
            "proposalId": proposal_id,
            "count": applied,
        }),
    );
    tracing::info!(target: "nightcore", run_id = %run_id, proposal_id = %proposal_id, count = applied, "harness proposal bundle applied");
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
    validate_armable_check_kind(&kind)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_armable_check_kind_validates() {
        // The full producer set: the three original gauntlet kinds plus the
        // hardening-catalog kinds (#4 secret-scan, #11 lockfile-lint, #13 env-contract,
        // #17 mutation-score, #18 ast-grep + api-extractor). Each must arm — a kind
        // listed here but rejected would strand its module's harnessCheck suggestion
        // with no way to go live.
        for kind in [
            "lint-plugin",
            "dependency-cruiser",
            "coverage-threshold",
            "lockfile-lint",
            "env-contract",
            "secret-scan",
            "mutation-score",
            "ast-grep",
            "api-extractor",
        ] {
            assert!(
                validate_armable_check_kind(kind).is_ok(),
                "kind {kind:?} must be armable"
            );
        }
    }

    #[test]
    fn stray_check_kinds_are_rejected() {
        // A kind outside the allowlist must never land a manifest entry: the gauntlet
        // would warn-and-skip it, leaving the user believing a gate is armed that never
        // runs. Case/format near-misses are rejected too (wire kinds are exact).
        for kind in [
            "",
            "shell",
            "Lint-Plugin",
            "lint_plugin",
            "secret_scan",
            "secret-scan ",
            "astgrep",
            "ast_grep",
            "Api-Extractor",
        ] {
            let err = validate_armable_check_kind(kind).unwrap_err();
            assert!(
                err.contains("unknown check kind"),
                "kind {kind:?} must be rejected, got: {err}"
            );
        }
    }
}
