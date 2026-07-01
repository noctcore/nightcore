//! Insight (codebase analysis) commands + the reader-side handling of the
//! `analysis-*` event family.
//!
//! Commands (web → Rust): `start_analysis` dispatches a `start-analysis`
//! `SurfaceCommand` to the sidecar (whose `SessionManager` fans out the read-only
//! category passes) and creates the persisted run; `cancel_analysis` aborts it;
//! the rest are pure store reads/mutations (list/get/dismiss/restore/delete) plus
//! `convert_finding_to_task`, which mints a board task from a finding.
//!
//! Reader (sidecar → Rust): [`handle_analysis_event`] forwards every `analysis-*`
//! event to the `nc:insight` channel for the live UI and, on `analysis-completed`,
//! finalizes the persisted run — applying dismissed-history reconciliation so a
//! re-discovered, previously-dismissed finding stays dismissed.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::contracts::{AnalysisScope, EffortLevel, FindingCategory, SurfaceCommand};
use crate::project::ProjectStore;
use crate::store::insight::{InsightRun, InsightStore, InsightUsage, StoredFinding};
use crate::store::TaskStore;
use crate::task::{Task, TaskKind, TASK_EVENT};

use super::scan::{
    begin_scan_run, dispatch_scan_command, failure_reason, finalize_completed,
    scan_lifecycle_commands, wire_str, ScanRunInit, ScanTelemetry,
};
use super::INSIGHT_EVENT;

// The four store-agnostic lifecycle commands (list / get / delete / cancel), stamped
// from the shared scan macro instead of hand-copied per feature.
scan_lifecycle_commands! {
    store: InsightStore,
    run: InsightRun,
    list: list_insight_runs,
    get: get_insight_run,
    delete: delete_insight_run,
    cancel: cancel_analysis,
    cancel_command: CancelAnalysis,
    item: "insight",
}

/// Resolve the changed files for `diff` scope: tracked changes vs `HEAD` plus
/// untracked-but-not-ignored files. Best-effort — a non-repo / git failure yields
/// an empty list (the passes then fall back to exploring the whole repo).
fn changed_files(project_path: &str) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    let collect = |args: &[&str], out: &mut Vec<String>| {
        if let Ok(o) = crate::platform::std_command("git")
            .args(args)
            .current_dir(project_path)
            .output()
        {
            if o.status.success() {
                for line in String::from_utf8_lossy(&o.stdout).lines() {
                    let line = line.trim();
                    if !line.is_empty() {
                        out.push(line.to_string());
                    }
                }
            }
        }
    };
    collect(&["diff", "--name-only", "HEAD"], &mut files);
    collect(&["ls-files", "--others", "--exclude-standard"], &mut files);
    files.sort();
    files.dedup();
    files
}

/// Start an Insight analysis run over the active project. Creates the persisted run
/// (status `running`), dispatches the `start-analysis` command, and returns the
/// `runId` the `analysis-*` events correlate by.
#[tauri::command]
pub async fn start_analysis(
    app: AppHandle,
    projects: State<'_, ProjectStore>,
    insight_store: State<'_, InsightStore>,
    scope: AnalysisScope,
    categories: Vec<FindingCategory>,
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
        "select at least one category to analyze",
        "no active project to analyze",
        model.as_deref(),
    )?;
    let scope_str = wire_str(&scope);
    let category_strs: Vec<String> = categories.iter().map(wire_str).collect();

    // Persist the run as `running` up front so it shows immediately in the list.
    let run = InsightRun {
        id: run_id.clone(),
        project_path: project_path.clone(),
        scope: scope_str,
        status: "running".to_string(),
        categories: category_strs,
        model: model_str,
        created_at: now,
        updated_at: now,
        cost_usd: 0.0,
        duration_ms: 0,
        usage: InsightUsage::default(),
        findings: Vec::new(),
        error: None,
    };
    insight_store.upsert(&run)?;

    // Resolve the changed-file focus for diff scope (Rust owns git; the engine
    // focuses the passes on these files).
    let changed = match scope {
        AnalysisScope::Diff => {
            let files = changed_files(&project_path);
            (!files.is_empty()).then_some(files)
        }
        AnalysisScope::Repo => None,
    };

    // Ensure the sidecar is up, then dispatch the analysis command; on failure the
    // shared helper persists the run's failed-state (so it doesn't look stuck).
    let command = SurfaceCommand::StartAnalysis {
        run_id: run_id.clone(),
        project_path,
        scope,
        changed_files: changed,
        categories,
        model,
        effort,
        max_concurrency: None,
        max_turns_per_category: None,
        max_budget_usd_per_category: None,
    };
    dispatch_scan_command(&app, "insight", &run_id, command, |msg| {
        insight_store
            .mutate(&run_id, |r| {
                r.status = "failed".to_string();
                r.error = Some(msg.to_string());
            })
            .map(|_| ())
    })
    .await?;

    tracing::info!(target: "nightcore", run_id = %run_id, "insight analysis started");
    Ok(run_id)
}

/// Mark a finding dismissed (it stays dismissed across future re-runs).
#[tauri::command]
pub fn dismiss_finding(
    insight_store: State<'_, InsightStore>,
    run_id: String,
    finding_id: String,
) -> Result<InsightRun, String> {
    insight_store.set_finding_status(&run_id, &finding_id, "dismissed", None)
}

/// Restore a dismissed finding back to open.
#[tauri::command]
pub fn restore_finding(
    insight_store: State<'_, InsightStore>,
    run_id: String,
    finding_id: String,
) -> Result<InsightRun, String> {
    insight_store.set_finding_status(&run_id, &finding_id, "open", None)
}

/// Convert a finding into a board task. Idempotent: if the finding already links to
/// a live task, that task is returned instead of minting a duplicate. Maps the
/// category to a task kind, builds a markdown description from the finding, persists
/// the task, marks the finding `converted` + linked, and emits both events.
#[tauri::command]
pub fn convert_finding_to_task(
    app: AppHandle,
    store: State<'_, TaskStore>,
    insight_store: State<'_, InsightStore>,
    run_id: String,
    finding_id: String,
) -> Result<Task, String> {
    let finding = insight_store
        .get_finding(&run_id, &finding_id)
        .ok_or_else(|| format!("finding {finding_id} not found in run {run_id}"))?;

    // Fast-path idempotency: a finding already linked to a still-existing task
    // returns it without minting anything (covers the common re-click).
    if let Some(existing_id) = finding.linked_task_id.as_deref() {
        if let Some(task) = store.get(existing_id) {
            return Ok(task);
        }
    }

    // Mint the task FIRST (so a crash before linking leaves an unlinked finding —
    // retryable — rather than a finding pointing at a non-existent task), then link
    // ATOMICALLY. The compare-and-set inside `link_finding_task` is the real guard
    // against two concurrent converts: a losing race gets `AlreadyLinked` and we
    // roll back the duplicate task we just created.
    let mut task = Task::new(finding.title.clone(), task_description(&finding));
    task.kind = category_to_kind(&finding.category);
    // upsert returns the store-stamped task (seq > 0); we MUST emit this snapshot,
    // not `task`, so the wire carries the assigned seq and is never dropped as stale.
    let stamped = store.upsert(&task)?;

    match insight_store.link_finding_task(&run_id, &finding_id, &task.id) {
        Ok(crate::store::insight::LinkOutcome::Linked) => {}
        Ok(crate::store::insight::LinkOutcome::AlreadyLinked(existing_id)) => {
            // Another convert won the race (or a prior link survived). Discard the
            // duplicate task we just minted and return the existing one if it lives.
            let _ = store.remove(&task.id);
            if let Some(existing) = store.get(&existing_id) {
                return Ok(existing);
            }
            // The linked task was deleted out from under us: re-point the finding at
            // the task we just (re)created instead of leaving a dangling link.
            store.upsert(&task)?;
            insight_store.set_finding_status(
                &run_id,
                &finding_id,
                "converted",
                Some(Some(task.id.clone())),
            )?;
        }
        Err(e) => {
            // Linking failed (run/finding vanished): roll back the orphan task so a
            // retry is clean rather than leaving an unlinked board task behind.
            let _ = store.remove(&task.id);
            return Err(e);
        }
    }

    let _ = app.emit(TASK_EVENT, &stamped);
    let _ = app.emit(
        INSIGHT_EVENT,
        json!({
            "type": "finding-converted",
            "runId": run_id,
            "findingId": finding_id,
            "taskId": stamped.id,
        }),
    );
    tracing::info!(target: "nightcore", task_id = %stamped.id, finding_id = %finding_id, "finding converted to task");
    Ok(stamped)
}

/// Map a finding category to the task kind a fix belongs to. Insight findings are
/// actionable work, so they all become `build` tasks (the kind that actually
/// edits + verifies); the category is preserved in the task description.
fn category_to_kind(_category: &str) -> TaskKind {
    TaskKind::Build
}

/// Build the markdown task description from a finding's fields + provenance.
fn task_description(f: &StoredFinding) -> String {
    let mut out = String::new();
    out.push_str(&f.description);
    out.push_str("\n\n");
    out.push_str(&format!(
        "**Category:** {} · **Severity:** {} · **Effort:** {}\n",
        f.category, f.severity, f.effort
    ));
    if let Some(loc) = &f.location {
        let lines = match (loc.start_line, loc.end_line) {
            (Some(s), Some(e)) if e != s => format!(":{s}-{e}"),
            (Some(s), _) => format!(":{s}"),
            _ => String::new(),
        };
        out.push_str(&format!("**Location:** `{}{}`\n", loc.file, lines));
    }
    if let Some(r) = &f.rationale {
        out.push_str(&format!("\n**Why it matters:** {r}\n"));
    }
    if let Some(s) = &f.suggestion {
        out.push_str(&format!("\n**Suggested fix:** {s}\n"));
    }
    if let (Some(before), Some(after)) = (&f.code_before, &f.code_after) {
        out.push_str(&format!(
            "\n```\n// before\n{before}\n```\n```\n// after\n{after}\n```\n"
        ));
    }
    if !f.affected_files.is_empty() {
        out.push_str(&format!(
            "\n**Affected files:** {}\n",
            f.affected_files.join(", ")
        ));
    }
    out.push_str("\n---\n_Created from an Insight analysis finding._\n");
    out
}

/// Reader-side: forward an `analysis-*` event to the `nc:insight` channel and, on
/// the terminal events, finalize/fail the persisted run. The intermediate events
/// (`started` / `category-*`) are forwarded for the live UI; persistence happens on
/// `analysis-completed` (authoritative, deduped) and `analysis-failed`.
pub(crate) async fn handle_analysis_event(app: &AppHandle, event_type: &str, event: &Value) {
    // Always forward the raw event so the live panel can stream optimistically.
    let _ = app.emit(INSIGHT_EVENT, event);

    let Some(run_id) = event.get("runId").and_then(Value::as_str) else {
        return;
    };
    let insight_store = app.state::<InsightStore>();

    match event_type {
        "analysis-completed" => {
            // Parse the final, cross-category-deduped findings the engine produced.
            let mut findings: Vec<StoredFinding> = event
                .get("findings")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(StoredFinding::from_wire).collect())
                .unwrap_or_default();

            // Dismissed-history reconciliation: a re-discovered finding whose
            // fingerprint was previously dismissed stays dismissed.
            let dismissed = insight_store.dismissed_fingerprints(Some(run_id));
            for f in &mut findings {
                if dismissed.contains(&f.fingerprint) {
                    f.status = "dismissed".to_string();
                }
            }

            let tel = ScanTelemetry::from_event(event);
            let count = findings.len();

            // The shared finalizer owns the idempotency guard + status/telemetry stamp; we
            // inject only the in-run lifecycle carry-forward (a finding the user
            // dismissed/converted from the live stream during this run), by fingerprint, so
            // the wholesale `findings` replace doesn't reset it to `open`. The cross-run
            // dismissed set was already applied to `findings` above.
            let finalized =
                finalize_completed(insight_store.inner(), "insight", run_id, &tel, move |run| {
                    let prior: std::collections::HashMap<String, (String, Option<String>)> =
                        run.findings
                            .iter()
                            .filter(|f| f.status != "open")
                            .map(|f| {
                                (
                                    f.fingerprint.clone(),
                                    (f.status.clone(), f.linked_task_id.clone()),
                                )
                            })
                            .collect();
                    let mut merged = findings;
                    for f in &mut merged {
                        if let Some((status, link)) = prior.get(&f.fingerprint) {
                            f.status = status.clone();
                            f.linked_task_id = link.clone();
                        }
                    }
                    run.findings = merged;
                });
            if finalized {
                tracing::info!(target: "nightcore", run_id, findings = count, cost_usd = tel.cost_usd, "insight analysis completed");
            }
        }
        "analysis-failed" => {
            let reason = failure_reason(event);
            let _ = insight_store.mutate(run_id, |run| {
                run.status = "failed".to_string();
                run.error = Some(reason.clone());
            });
            tracing::info!(target: "nightcore", run_id, reason, "insight analysis ended (failed/aborted)");
        }
        // Intermediate lifecycle events: forwarded above for the live UI, and logged
        // here (mirroring reader.rs's session logging) so a long analysis's progress
        // reaches the terminal instead of going silent between the two endpoints.
        "analysis-category-started" => {
            let category = event
                .get("category")
                .and_then(Value::as_str)
                .unwrap_or("");
            tracing::info!(target: "nightcore", run_id, category, "insight category started");
        }
        "analysis-category-completed" => {
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
            tracing::info!(target: "nightcore", run_id, category, findings, cost_usd = cost, "insight category completed");
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{AnalysisScope, FindingCategory};
    use crate::store::insight::{FindingLocation, StoredFinding};

    fn minimal_finding() -> StoredFinding {
        StoredFinding {
            id: "f1".to_string(),
            category: "perf".to_string(),
            severity: "high".to_string(),
            effort: "low".to_string(),
            title: "Slow query".to_string(),
            description: "N+1 query in user list".to_string(),
            rationale: None,
            location: None,
            suggestion: None,
            code_before: None,
            code_after: None,
            affected_files: Vec::new(),
            tags: Vec::new(),
            confidence: None,
            fingerprint: "fp-abc".to_string(),
            status: "open".to_string(),
            linked_task_id: None,
        }
    }

    #[test]
    fn category_to_kind_always_returns_build() {
        // All categories map to Build so findings become actionable work tasks.
        for cat in &["perf", "security", "ui-ux", "refactor", "test", "arch", "unknown"] {
            assert_eq!(
                category_to_kind(cat),
                TaskKind::Build,
                "category {cat} should map to Build"
            );
        }
    }

    #[test]
    fn wire_str_serializes_scope_to_wire_string() {
        assert_eq!(wire_str(&AnalysisScope::Diff), "diff");
        assert_eq!(wire_str(&AnalysisScope::Repo), "repo");
    }

    #[test]
    fn wire_str_serializes_category_to_wire_string() {
        // Spot-check a few well-known categories to confirm the mapping.
        let perf = wire_str(&FindingCategory::Performance);
        assert!(!perf.is_empty(), "performance category should serialize to a non-empty string");
        let sec = wire_str(&FindingCategory::Security);
        assert!(!sec.is_empty(), "security category should serialize to a non-empty string");
    }

    #[test]
    fn task_description_contains_required_fields() {
        let f = minimal_finding();
        let desc = task_description(&f);
        assert!(desc.contains("N+1 query in user list"), "should include description");
        assert!(desc.contains("perf"), "should include category");
        assert!(desc.contains("high"), "should include severity");
        assert!(desc.contains("low"), "should include effort");
        assert!(desc.contains("Insight analysis finding"), "should include provenance footer");
    }

    #[test]
    fn task_description_with_location_single_line() {
        let mut f = minimal_finding();
        f.location = Some(FindingLocation {
            file: "src/lib.rs".to_string(),
            start_line: Some(42),
            end_line: None,
            symbol: None,
        });
        let desc = task_description(&f);
        assert!(desc.contains("src/lib.rs:42"), "should format single-line location");
    }

    #[test]
    fn task_description_with_location_range() {
        let mut f = minimal_finding();
        f.location = Some(FindingLocation {
            file: "src/main.rs".to_string(),
            start_line: Some(10),
            end_line: Some(20),
            symbol: None,
        });
        let desc = task_description(&f);
        assert!(desc.contains("src/main.rs:10-20"), "should format line range");
    }

    #[test]
    fn task_description_with_same_start_and_end_line_omits_range() {
        let mut f = minimal_finding();
        f.location = Some(FindingLocation {
            file: "src/main.rs".to_string(),
            start_line: Some(5),
            end_line: Some(5),
            symbol: None,
        });
        let desc = task_description(&f);
        // Same start/end → should format as `:5` not `:5-5`
        assert!(desc.contains("src/main.rs:5"), "same start/end shows single line");
        assert!(!desc.contains(":5-5"), "should not show redundant range");
    }

    #[test]
    fn task_description_with_rationale_and_suggestion() {
        let mut f = minimal_finding();
        f.rationale = Some("Causes timeouts under load".to_string());
        f.suggestion = Some("Add an index on user_id".to_string());
        let desc = task_description(&f);
        assert!(desc.contains("Causes timeouts under load"), "should include rationale");
        assert!(desc.contains("Add an index on user_id"), "should include suggestion");
    }

    #[test]
    fn task_description_with_code_diff() {
        let mut f = minimal_finding();
        f.code_before = Some("SELECT * FROM users".to_string());
        f.code_after = Some("SELECT id FROM users WHERE id = ?".to_string());
        let desc = task_description(&f);
        assert!(desc.contains("// before"), "should include before block marker");
        assert!(desc.contains("// after"), "should include after block marker");
        assert!(desc.contains("SELECT * FROM users"), "should include before code");
        assert!(desc.contains("SELECT id FROM users WHERE id = ?"), "should include after code");
    }

    #[test]
    fn task_description_with_affected_files() {
        let mut f = minimal_finding();
        f.affected_files = vec!["src/a.rs".to_string(), "src/b.rs".to_string()];
        let desc = task_description(&f);
        assert!(desc.contains("src/a.rs"), "should include first affected file");
        assert!(desc.contains("src/b.rs"), "should include second affected file");
    }

    #[test]
    fn task_description_without_optional_fields_does_not_panic() {
        // All optional fields absent — just verifying no panic and basic structure.
        let f = minimal_finding();
        let desc = task_description(&f);
        assert!(!desc.is_empty());
    }
}
