//! Harness (codebase convention auditor) commands + the reader-side handling of the
//! `harness-*` event family.
//!
//! Commands (web → Rust): `start_harness_scan` dispatches a `start-harness-scan`
//! `SurfaceCommand` to the sidecar (whose `SessionManager` detects the repo profile,
//! fans out the read-only convention passes, then synthesizes proposed artifacts) and
//! creates the persisted run; `cancel_harness_scan` aborts it; the rest are store
//! reads/mutations PLUS the one write-bearing command, `apply_harness_artifact`, which
//! writes a proposed artifact into the TARGET REPO. That write is the only place this
//! feature touches a user's files, so it is defended hard: the destination must resolve
//! inside the project root (lexical `..`/absolute rejection THEN a canonicalized
//! containment check that also defeats symlink escapes), `create` never clobbers an
//! existing file (`create_new`), and doc artifacts merge into a delimited managed block.
//!
//! Reader (sidecar → Rust): [`handle_harness_event`] forwards every `harness-*` event to
//! the `nc:harness` channel and, on `harness-scan-completed`, finalizes the persisted
//! run — carrying dismissed findings and applied/dismissed artifacts forward by
//! fingerprint so a re-scan doesn't reset the user's lifecycle edits.

use std::io::Write as _;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::contracts::{ConventionCategory, EffortLevel, SurfaceCommand};
use crate::orchestration::coordinator::Orchestrator;
use crate::project::ProjectStore;
use crate::store::harness::{
    ApplyOutcome, HarnessRun, HarnessStore, HarnessUsage, StoredConventionFinding,
    StoredProposedArtifact, StoredRepoProfile,
};
use crate::task::now_ms;

use super::{ensure_reader, HARNESS_EVENT};

/// The delimiters bounding the managed block a `merge-section` artifact owns inside a
/// CLAUDE.md / AGENTS.md. Re-applying replaces only the block between these markers, so
/// the user's surrounding hand-written content is never touched.
const SECTION_START: &str = "<!-- nightcore:harness:start -->";
const SECTION_END: &str = "<!-- nightcore:harness:end -->";

/// Serialize a generated wire enum to its wire string (e.g. `ConventionCategory::FolderStructure`
/// → `"folder-structure"`).
fn wire_str<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
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
    if categories.is_empty() {
        return Err("select at least one convention lens to scan".to_string());
    }
    let project = projects.active().ok_or("no active project to scan")?;
    let project_path = project.path.clone();

    let run_id = uuid::Uuid::new_v4().to_string();
    let category_strs: Vec<String> = categories.iter().map(wire_str).collect();
    let model_str = model.clone().unwrap_or_default();
    let now = now_ms();

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

    // Ensure the sidecar is up, then dispatch the scan command.
    if let Err(e) = ensure_reader(&app).await {
        let _ = harness_store.mutate(&run_id, |r| {
            r.status = "failed".to_string();
            r.error = Some(e.clone());
        });
        return Err(e);
    }

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
    let orch = app.state::<Orchestrator>();
    if let Err(e) = orch.provider.dispatch_command(command).await {
        let _ = harness_store.mutate(&run_id, |r| {
            r.status = "failed".to_string();
            r.error = Some(e.clone());
        });
        return Err(e);
    }

    tracing::info!(target: "nightcore", run_id = %run_id, "harness scan started");
    Ok(run_id)
}

/// Cancel an in-flight scan (aborts every convention pass + synthesis).
#[tauri::command]
pub async fn cancel_harness_scan(app: AppHandle, run_id: String) -> Result<(), String> {
    let orch = app.state::<Orchestrator>();
    let command = SurfaceCommand::CancelHarnessScan {
        run_id: run_id.clone(),
    };
    orch.provider.dispatch_command(command).await
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

/// Resolve a repo-relative artifact path against `root`, rejecting anything that could
/// escape the project. Defence in layers:
///  1. lexical: reject empty / absolute / any `..` or root/prefix component, so the join
///     can't climb out before we ever touch the filesystem;
///  2. canonical: ensure the deepest EXISTING ancestor of the destination canonicalizes
///     to inside the canonical project root — this defeats a symlinked directory in the
///     path that lexical checks can't see.
/// Returns the absolute destination path (which may not exist yet, for `create`).
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.trim().is_empty() {
        return Err("artifact target path is empty".to_string());
    }
    let rel_path = Path::new(rel);
    for comp in rel_path.components() {
        match comp {
            Component::Normal(_) => {}
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!("artifact path escapes the project (`..`): {rel}"))
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("artifact path must be repo-relative, not absolute: {rel}"))
            }
        }
    }

    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("project root {} is not accessible: {e}", root.display()))?;
    let dest = root_canon.join(rel_path);

    // Walk the destination component-by-component from the root, using lstat
    // (`symlink_metadata`, which does NOT follow links — unlike `exists()`) and reject
    // ANY existing component that is a symlink, dangling or live. This is the real
    // symlink-escape guard: a DANGLING symlink leaf (e.g. an untrusted scanned repo
    // shipping `AGENTS.md -> /outside`) reports `exists() == false`, so a naive
    // ancestor walk skips past it and a later `fs::write` follows it OUT of the project
    // root. lstat sees the link itself. An in-root symlink (`AGENTS.md -> src/main.rs`)
    // is likewise rejected so a merge can't corrupt an unrelated repo file. A
    // not-yet-existing component is fine — there is nothing to follow.
    let mut current = root_canon.clone();
    for comp in rel_path.components() {
        let Component::Normal(name) = comp else {
            continue;
        };
        current.push(name);
        if let Ok(meta) = std::fs::symlink_metadata(&current) {
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "artifact path passes through a symlink (rejected): {rel}"
                ));
            }
        }
    }

    // Defence in depth: the deepest existing ancestor must still canonicalize to
    // inside the root (catches any non-symlink escape the lexical check missed). With
    // no symlink in the chain (rejected above), this can only differ from the lexical
    // `dest` if the root itself moved — still safe to assert.
    let mut probe = dest.as_path();
    let existing = loop {
        if std::fs::symlink_metadata(probe).is_ok() {
            break probe
                .canonicalize()
                .map_err(|e| format!("cannot resolve {}: {e}", probe.display()))?;
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => return Err("artifact path has no resolvable ancestor".to_string()),
        }
    };
    if existing != root_canon && !existing.starts_with(&root_canon) {
        return Err(format!(
            "artifact path resolves outside the project root: {rel}"
        ));
    }
    Ok(dest)
}

/// Write a brand-new file, FAILING if it already exists (never clobber). `create_new` is
/// the atomic no-clobber guard — it closes the check-then-write race a separate `exists()`
/// test would leave open. Creates any missing parent directories first.
fn write_create(dest: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
    {
        Ok(mut file) => file
            .write_all(content.as_bytes())
            .map_err(|e| format!("failed to write {}: {e}", dest.display())),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(format!(
            "{} already exists — refusing to overwrite it",
            dest.display()
        )),
        Err(e) => Err(format!("cannot create {}: {e}", dest.display())),
    }
}

/// Insert or replace the managed block inside `dest` with `body`. The existing file (or
/// empty when absent) is read, the block between the markers is replaced (or appended if
/// no markers are present yet), and the result is written ATOMICALLY (temp file + rename).
/// The user's content outside the markers is preserved verbatim. The atomic rename also
/// hardens the write: `rename` REPLACES a destination symlink rather than following it (a
/// second guard atop `safe_join`'s symlink rejection), and a crash mid-write can never
/// truncate the user's hand-written CLAUDE.md/AGENTS.md.
fn write_merge_section(dest: &Path, body: &str) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let existing = std::fs::read_to_string(dest).unwrap_or_default();
    let merged = merge_managed_section(&existing, body);
    crate::store::write_atomic(dest, merged.as_bytes())
        .map_err(|e| format!("failed to write {}: {e}", dest.display()))
}

/// Pure: produce the new file contents with `body` placed inside the managed markers.
/// Replaces an existing managed block, or appends a fresh one (with a separating blank
/// line) when none is present. Kept pure so it is unit-testable without the filesystem.
fn merge_managed_section(existing: &str, body: &str) -> String {
    let block = format!("{SECTION_START}\n{}\n{SECTION_END}", body.trim_end());
    if let (Some(start), Some(end)) = (existing.find(SECTION_START), existing.find(SECTION_END)) {
        if end >= start {
            let end_full = end + SECTION_END.len();
            let mut out = String::with_capacity(existing.len() + body.len());
            out.push_str(&existing[..start]);
            out.push_str(&block);
            out.push_str(&existing[end_full..]);
            return out;
        }
    }
    if existing.trim().is_empty() {
        format!("{block}\n")
    } else {
        format!("{}\n\n{block}\n", existing.trim_end())
    }
}

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

            let cost = event.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0);
            let duration = event.get("durationMs").and_then(Value::as_u64).unwrap_or(0);
            let usage = event.get("usage");
            let input_tokens = usage
                .and_then(|u| u.get("inputTokens"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let output_tokens = usage
                .and_then(|u| u.get("outputTokens"))
                .and_then(Value::as_u64)
                .unwrap_or(0);

            let result = harness_store.mutate(run_id, |run| {
                // Idempotency: a duplicate completion for an already-finalized run must
                // not reset the user's lifecycle edits. A clean repo can finalize with
                // zero findings but proposed artifacts (synthesis runs regardless), so
                // the guard checks BOTH collections — findings-only would miss that case.
                if run.status == "completed"
                    && (!run.findings.is_empty() || !run.artifacts.is_empty())
                {
                    return;
                }
                // Carry IN-RUN finding lifecycle (dismissed live during this scan).
                let prior_findings: std::collections::HashMap<String, String> = run
                    .findings
                    .iter()
                    .filter(|f| f.status != "open")
                    .map(|f| (f.fingerprint.clone(), f.status.clone()))
                    .collect();
                let mut merged_findings = findings.clone();
                for f in &mut merged_findings {
                    if let Some(status) = prior_findings.get(&f.fingerprint) {
                        f.status = status.clone();
                    }
                }
                // Carry IN-RUN artifact lifecycle (applied/dismissed live during this scan),
                // preserving applied_path AND applied_at so a re-finalize never nulls the
                // apply timestamp.
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
                let mut merged_artifacts = artifacts.clone();
                for a in &mut merged_artifacts {
                    if let Some((status, path, at)) = prior_in_run.get(&a.fingerprint) {
                        a.status = status.clone();
                        a.applied_path = path.clone();
                        a.applied_at = *at;
                    }
                }

                run.status = "completed".to_string();
                run.profile = profile.clone();
                run.findings = merged_findings;
                run.artifacts = merged_artifacts;
                run.cost_usd = cost;
                run.duration_ms = duration;
                run.usage = HarnessUsage {
                    input_tokens,
                    output_tokens,
                };
                run.synthesizing = false;
                run.error = None;
            });
            if let Err(e) = result {
                tracing::warn!(target: "nightcore", run_id, error = %e, "failed to finalize harness run");
            } else {
                tracing::info!(target: "nightcore", run_id, findings = findings.len(), artifacts = artifacts.len(), cost_usd = cost, "harness scan completed");
            }
        }
        "harness-scan-failed" => {
            let reason = event
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let message = event
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let _ = harness_store.mutate(run_id, |run| {
                run.status = "failed".to_string();
                run.synthesizing = false;
                run.error = Some(if message.is_empty() {
                    reason.to_string()
                } else {
                    message
                });
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn safe_join_accepts_a_repo_relative_path() {
        let tmp = TempDir::new().unwrap();
        let dest = safe_join(tmp.path(), "packages/eslint-plugin/index.ts").unwrap();
        assert!(dest.starts_with(tmp.path().canonicalize().unwrap()));
        assert!(dest.ends_with("packages/eslint-plugin/index.ts"));
    }

    #[test]
    fn safe_join_rejects_parent_escape() {
        let tmp = TempDir::new().unwrap();
        for bad in ["../escape.ts", "a/../../escape.ts", "../../etc/passwd"] {
            assert!(
                safe_join(tmp.path(), bad).is_err(),
                "must reject traversal {bad:?}"
            );
        }
    }

    #[test]
    fn safe_join_rejects_absolute_path() {
        let tmp = TempDir::new().unwrap();
        for bad in ["/etc/passwd", "/tmp/x.ts"] {
            assert!(
                safe_join(tmp.path(), bad).is_err(),
                "must reject absolute {bad:?}"
            );
        }
    }

    #[test]
    fn safe_join_rejects_symlink_escape() {
        // A symlinked dir inside the repo pointing outside must not let a write escape.
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let link = root.path().join("link");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), &link).unwrap();
            let result = safe_join(root.path(), "link/escape.ts");
            assert!(result.is_err(), "symlinked dir escaping the root must be rejected");
        }
        #[cfg(not(unix))]
        {
            let _ = (link, outside);
        }
    }

    #[cfg(unix)]
    #[test]
    fn safe_join_rejects_dangling_leaf_symlink() {
        // The reviewer's HIGH finding: a DANGLING symlink at the leaf (target absent)
        // reports exists()==false, so a naive ancestor walk skips past it and a later
        // merge-section `fs::write` follows it OUT of the project root. lstat must catch
        // the link itself and reject the path. `AGENTS.md`/`CLAUDE.md` are the realistic
        // targets (agent-contract artifacts use merge-section).
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap().path().join("evil-not-yet-created");
        std::os::unix::fs::symlink(&outside, root.path().join("AGENTS.md")).unwrap();
        assert!(
            !root.path().join("AGENTS.md").exists(),
            "precondition: the symlink is dangling (target does not exist)"
        );
        assert!(
            safe_join(root.path(), "AGENTS.md").is_err(),
            "a dangling-leaf symlink must be rejected, not followed out of the root"
        );
        assert!(!outside.exists(), "nothing must have been written outside the root");
    }

    #[cfg(unix)]
    #[test]
    fn safe_join_rejects_in_root_symlink_leaf() {
        // An IN-ROOT symlink leaf (AGENTS.md -> src/main.rs) passes canonical containment
        // but a merge would corrupt an unrelated repo file. lstat rejects it.
        let root = TempDir::new().unwrap();
        std::fs::create_dir_all(root.path().join("src")).unwrap();
        std::fs::write(root.path().join("src/main.rs"), "fn main() {}").unwrap();
        std::os::unix::fs::symlink(
            root.path().join("src/main.rs"),
            root.path().join("AGENTS.md"),
        )
        .unwrap();
        assert!(
            safe_join(root.path(), "AGENTS.md").is_err(),
            "an in-root symlink leaf must be rejected so a merge can't corrupt another file"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("src/main.rs")).unwrap(),
            "fn main() {}",
            "the symlink target file is untouched"
        );
    }

    #[test]
    fn write_create_refuses_to_clobber() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("AGENTS.md");
        write_create(&dest, "first").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "first");
        // A second create must NOT overwrite.
        assert!(write_create(&dest, "second").is_err());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "first");
    }

    #[test]
    fn write_create_makes_missing_parent_dirs() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("packages/eslint-plugin/src/index.ts");
        write_create(&dest, "export {}").unwrap();
        assert!(dest.exists());
    }

    #[test]
    fn merge_section_appends_then_replaces_in_place() {
        // Append into existing content, preserving the user's prose.
        let original = "# Project\n\nHand-written intro.\n";
        let merged = merge_managed_section(original, "## Conventions\n- folder-per-component");
        assert!(merged.contains("Hand-written intro."));
        assert!(merged.contains(SECTION_START));
        assert!(merged.contains("folder-per-component"));

        // Re-applying replaces the managed block only, leaving the prose intact.
        let remerged = merge_managed_section(&merged, "## Conventions\n- no-cross-feature-imports");
        assert!(remerged.contains("Hand-written intro."));
        assert!(remerged.contains("no-cross-feature-imports"));
        assert!(!remerged.contains("folder-per-component"), "old block replaced");
        // Exactly one managed block remains.
        assert_eq!(remerged.matches(SECTION_START).count(), 1);
    }

    #[test]
    fn merge_section_into_empty_file() {
        let merged = merge_managed_section("", "## Conventions\n- x");
        assert!(merged.starts_with(SECTION_START));
        assert!(merged.contains("- x"));
    }
}
