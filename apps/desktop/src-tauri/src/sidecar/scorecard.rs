//! Readiness Scorecard (Profile) commands + the reader-side handling of the
//! `scorecard-*` event family. The Profile twin of [`super::insight`].
//!
//! Commands (web → Rust): `start_scorecard` dispatches a `start-scorecard`
//! `SurfaceCommand` to the sidecar (whose `SessionManager` fans out the read-only
//! grading passes) and creates the persisted run; `cancel_scorecard` aborts it; the
//! rest are pure store reads/mutations (list/get/delete) plus `convert_reading_to_task`,
//! which mints a Build task whose prompt is the dimension's harden slash-command.
//!
//! Reader (sidecar → Rust): [`handle_scorecard_event`] forwards every `scorecard-*`
//! event to the `nc:scorecard` channel for the live UI and, on `scorecard-completed`,
//! finalizes the persisted run. UNLIKE Insight there is no dismissed-history
//! reconciliation — every scorecard run is a fresh snapshot grade.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::contracts::{EffortLevel, ScorecardDimension, SurfaceCommand};
use crate::orchestration::coordinator::Orchestrator;
use crate::project::ProjectStore;
use crate::store::scorecard::{ScorecardRun, ScorecardStore, StoredReading};
use crate::store::insight::InsightUsage;
use crate::store::TaskStore;
use crate::task::{now_ms, Task, TaskKind, TASK_EVENT};

use super::{ensure_reader, SCORECARD_EVENT};

/// Serialize a generated wire enum to its wire string (e.g.
/// `ScorecardDimension::ErrorHandling` → `"error-handling"`).
fn wire_str<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Start a Readiness Scorecard run over the active project. Creates the persisted
/// run (status `running`), dispatches the `start-scorecard` command, and returns the
/// `runId` the `scorecard-*` events correlate by.
#[tauri::command]
pub async fn start_scorecard(
    app: AppHandle,
    projects: State<'_, ProjectStore>,
    scorecard_store: State<'_, ScorecardStore>,
    dimensions: Vec<ScorecardDimension>,
    model: Option<String>,
    effort: Option<EffortLevel>,
) -> Result<String, String> {
    if dimensions.is_empty() {
        return Err("select at least one dimension to grade".to_string());
    }
    let project = projects.active().ok_or("no active project to grade")?;
    let project_path = project.path.clone();

    let run_id = uuid::Uuid::new_v4().to_string();
    let dimension_strs: Vec<String> = dimensions.iter().map(wire_str).collect();
    let model_str = model.clone().unwrap_or_default();
    let now = now_ms();

    // Persist the run as `running` up front so it shows immediately in the list.
    let run = ScorecardRun {
        id: run_id.clone(),
        project_path: project_path.clone(),
        status: "running".to_string(),
        dimensions: dimension_strs,
        model: model_str,
        created_at: now,
        updated_at: now,
        cost_usd: 0.0,
        duration_ms: 0,
        usage: InsightUsage::default(),
        readings: Vec::new(),
        error: None,
    };
    scorecard_store.upsert(&run)?;

    // Ensure the sidecar is up, then dispatch the scorecard command.
    if let Err(e) = ensure_reader(&app).await {
        let _ = scorecard_store.mutate(&run_id, |r| {
            r.status = "failed".to_string();
            r.error = Some(e.clone());
        });
        return Err(e);
    }

    let command = SurfaceCommand::StartScorecard {
        run_id: run_id.clone(),
        project_path,
        dimensions,
        model,
        effort,
        max_concurrency: None,
        max_turns_per_dimension: None,
        max_budget_usd_per_dimension: None,
    };
    let orch = app.state::<Orchestrator>();
    if let Err(e) = orch.provider.dispatch_command(command).await {
        let _ = scorecard_store.mutate(&run_id, |r| {
            r.status = "failed".to_string();
            r.error = Some(e.clone());
        });
        return Err(e);
    }

    tracing::info!(target: "nightcore", run_id = %run_id, "scorecard grading started");
    Ok(run_id)
}

/// Cancel an in-flight scorecard run (aborts every dimension pass).
#[tauri::command]
pub async fn cancel_scorecard(app: AppHandle, run_id: String) -> Result<(), String> {
    let orch = app.state::<Orchestrator>();
    let command = SurfaceCommand::CancelScorecard {
        run_id: run_id.clone(),
    };
    orch.provider.dispatch_command(command).await
}

/// All scorecard runs for the active project (newest first).
#[tauri::command]
pub fn list_scorecard_runs(
    scorecard_store: State<'_, ScorecardStore>,
) -> Result<Vec<ScorecardRun>, String> {
    Ok(scorecard_store.list())
}

/// One scorecard run by id.
#[tauri::command]
pub fn get_scorecard_run(
    scorecard_store: State<'_, ScorecardStore>,
    run_id: String,
) -> Result<Option<ScorecardRun>, String> {
    Ok(scorecard_store.get(&run_id))
}

/// Delete a scorecard run and its file.
#[tauri::command]
pub fn delete_scorecard_run(
    scorecard_store: State<'_, ScorecardStore>,
    run_id: String,
) -> Result<(), String> {
    scorecard_store.remove(&run_id)
}

/// Map a dimension wire string to the harden slash-command the "Harden this" button
/// dispatches as a Build task prompt. Mirrors `scorecard-presets.ts`'s `hardenSkill`;
/// these slash commands leverage skills the SDK loads in the target project. An
/// unknown dimension falls back to the general `/audit`.
fn harden_skill_for(dimension: &str) -> &'static str {
    match dimension {
        "architecture" => "/audit",
        "tests" => "/write-tests",
        "security" => "/security-audit",
        "error-handling" => "/add-empty-error-states",
        "observability" => "/add-observability",
        "dependencies" => "/audit",
        "performance" => "/audit-perf",
        "types" => "/harden-types",
        "a11y" => "/audit-a11y",
        "docs-ci" => "/sync-docs",
        _ => "/audit",
    }
}

/// Convert a reading into a board Build task that HARDENS that dimension. Idempotent:
/// if the reading already links to a live task, that task is returned instead of
/// minting a duplicate. The task's prompt LEADS with the dimension's slash-command
/// (e.g. `/security-audit`) so it leverages a skill the SDK already loaded; the
/// grade + evidence context follows as the description.
#[tauri::command]
pub fn convert_reading_to_task(
    app: AppHandle,
    store: State<'_, TaskStore>,
    scorecard_store: State<'_, ScorecardStore>,
    run_id: String,
    reading_id: String,
) -> Result<Task, String> {
    let reading = scorecard_store
        .get_reading(&run_id, &reading_id)
        .ok_or_else(|| format!("reading {reading_id} not found in run {run_id}"))?;

    // Fast-path idempotency: a reading already linked to a still-existing task
    // returns it without minting anything (covers the common re-click).
    if let Some(existing_id) = reading.linked_task_id.as_deref() {
        if let Some(task) = store.get(existing_id) {
            return Ok(task);
        }
    }

    // The prompt MUST lead with the slash-command so the SDK runs the dimension's
    // harden skill; the title is that command so `Task::prompt()` (title\n\ndesc)
    // begins with it.
    let skill = harden_skill_for(&reading.dimension);
    let mut task = Task::new(skill.to_string(), task_description(&reading, skill));
    task.kind = TaskKind::Build;
    // upsert returns the store-stamped task (seq > 0); we MUST emit this snapshot,
    // not `task`, so the wire carries the assigned seq and is never dropped as stale.
    let stamped = store.upsert(&task)?;

    match scorecard_store.link_reading_task(&run_id, &reading_id, &task.id) {
        Ok(crate::store::scorecard::LinkOutcome::Linked) => {}
        Ok(crate::store::scorecard::LinkOutcome::AlreadyLinked(existing_id)) => {
            // Another convert won the race (or a prior link survived). Discard the
            // duplicate task we just minted and return the existing one if it lives.
            let _ = store.remove(&task.id);
            if let Some(existing) = store.get(&existing_id) {
                return Ok(existing);
            }
            // The linked task was deleted out from under us: re-point the reading at
            // the task we just (re)created instead of leaving a dangling link. We must
            // use `set_reading_status` (an UNCONDITIONAL overwrite), NOT
            // `link_reading_task` — the latter is a compare-and-set that early-returns
            // `AlreadyLinked` whenever a link already exists, which is precisely this
            // case (the reading still points at the dead task id), so it would never
            // heal the dangling link.
            store.upsert(&task)?;
            scorecard_store.set_reading_status(
                &run_id,
                &reading_id,
                "converted",
                Some(Some(task.id.clone())),
            )?;
        }
        Err(e) => {
            // Linking failed (run/reading vanished): roll back the orphan task so a
            // retry is clean rather than leaving an unlinked board task behind.
            let _ = store.remove(&task.id);
            return Err(e);
        }
    }

    let _ = app.emit(TASK_EVENT, &stamped);
    let _ = app.emit(
        SCORECARD_EVENT,
        json!({
            "type": "reading-converted",
            "runId": run_id,
            "readingId": reading_id,
            "taskId": stamped.id,
        }),
    );
    tracing::info!(target: "nightcore", task_id = %stamped.id, reading_id = %reading_id, "reading hardened into task");
    Ok(stamped)
}

/// Build the markdown task description from a reading's fields + provenance. The
/// `skill` is restated so the body documents which audit the task runs.
fn task_description(r: &StoredReading, skill: &str) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "Harden the **{}** dimension (currently graded **{}**).\n\n",
        r.dimension, r.grade
    ));
    out.push_str(&format!("Run `{skill}` to drive the hardening pass.\n\n"));
    out.push_str(&r.summary);
    out.push('\n');
    if let Some(loc) = &r.location {
        let lines = match (loc.start_line, loc.end_line) {
            (Some(s), Some(e)) if e != s => format!(":{s}-{e}"),
            (Some(s), _) => format!(":{s}"),
            _ => String::new(),
        };
        out.push_str(&format!("\n**Location:** `{}{}`\n", loc.file, lines));
    }
    if let Some(rationale) = &r.rationale {
        out.push_str(&format!("\n**To raise the grade:** {rationale}\n"));
    }
    if let Some(s) = &r.suggestion {
        out.push_str(&format!("\n**Suggested action:** {s}\n"));
    }
    if !r.findings.is_empty() {
        out.push_str("\n**Evidence:**\n");
        for ev in &r.findings {
            match &ev.location {
                Some(loc) => {
                    let line = loc.start_line.map(|s| format!(":{s}")).unwrap_or_default();
                    out.push_str(&format!("- {} (`{}{}`)\n", ev.detail, loc.file, line));
                }
                None => out.push_str(&format!("- {}\n", ev.detail)),
            }
        }
    }
    if !r.affected_files.is_empty() {
        out.push_str(&format!(
            "\n**Affected files:** {}\n",
            r.affected_files.join(", ")
        ));
    }
    out.push_str("\n---\n_Created from a Readiness Scorecard reading._\n");
    out
}

/// Reader-side: forward a `scorecard-*` event to the `nc:scorecard` channel and, on
/// the terminal events, finalize/fail the persisted run. The intermediate events
/// (`started` / `dimension-*`) are forwarded for the live UI; persistence happens on
/// `scorecard-completed` (authoritative) and `scorecard-failed`.
pub(crate) async fn handle_scorecard_event(app: &AppHandle, event_type: &str, event: &Value) {
    // Always forward the raw event so the live panel can stream optimistically.
    let _ = app.emit(SCORECARD_EVENT, event);

    let Some(run_id) = event.get("runId").and_then(Value::as_str) else {
        return;
    };
    let scorecard_store = app.state::<ScorecardStore>();

    match event_type {
        "scorecard-completed" => {
            let readings: Vec<StoredReading> = event
                .get("readings")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(StoredReading::from_wire).collect())
                .unwrap_or_default();

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

            let result = scorecard_store.mutate(run_id, |run| {
                // Idempotency: a duplicate `scorecard-completed` for an already-
                // finalized run must not reset the user's lifecycle edits.
                if run.status == "completed" && !run.readings.is_empty() {
                    return;
                }
                // Carry over IN-RUN lifecycle (a reading the user hardened from the
                // live stream during this run) by fingerprint, so the wholesale
                // `readings` replace below doesn't reset it to `open`.
                let prior: std::collections::HashMap<String, (String, Option<String>)> =
                    run.readings
                        .iter()
                        .filter(|r| r.status != "open")
                        .map(|r| {
                            (
                                r.fingerprint.clone(),
                                (r.status.clone(), r.linked_task_id.clone()),
                            )
                        })
                        .collect();
                let mut merged = readings.clone();
                for r in &mut merged {
                    if let Some((status, link)) = prior.get(&r.fingerprint) {
                        r.status = status.clone();
                        r.linked_task_id = link.clone();
                    }
                }
                run.status = "completed".to_string();
                run.readings = merged;
                run.cost_usd = cost;
                run.duration_ms = duration;
                run.usage = InsightUsage {
                    input_tokens,
                    output_tokens,
                };
                run.error = None;
            });
            if let Err(e) = result {
                tracing::warn!(target: "nightcore", run_id, error = %e, "failed to finalize scorecard run");
            } else {
                tracing::info!(target: "nightcore", run_id, readings = readings.len(), cost_usd = cost, "scorecard grading completed");
            }
        }
        "scorecard-failed" => {
            let reason = event
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let message = event
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let _ = scorecard_store.mutate(run_id, |run| {
                run.status = "failed".to_string();
                run.error = Some(if message.is_empty() {
                    reason.to_string()
                } else {
                    message
                });
            });
            tracing::info!(target: "nightcore", run_id, reason, "scorecard grading ended (failed/aborted)");
        }
        "scorecard-dimension-started" => {
            let dimension = event.get("dimension").and_then(Value::as_str).unwrap_or("");
            tracing::info!(target: "nightcore", run_id, dimension, "scorecard dimension started");
        }
        "scorecard-dimension-completed" => {
            let dimension = event.get("dimension").and_then(Value::as_str).unwrap_or("");
            let grade = event
                .get("reading")
                .and_then(|r| r.get("grade"))
                .and_then(Value::as_str)
                .unwrap_or("-");
            let cost = event.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0);
            tracing::info!(target: "nightcore", run_id, dimension, grade, cost_usd = cost, "scorecard dimension completed");
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::scorecard::StoredReading;

    fn minimal_reading() -> StoredReading {
        StoredReading {
            id: "security-x".to_string(),
            dimension: "security".to_string(),
            grade: "C".to_string(),
            title: "Input validation gaps".to_string(),
            summary: "Several handlers trust unvalidated bodies".to_string(),
            rationale: None,
            location: None,
            suggestion: None,
            affected_files: Vec::new(),
            tags: Vec::new(),
            findings: Vec::new(),
            confidence: None,
            fingerprint: "fp".to_string(),
            status: "open".to_string(),
            linked_task_id: None,
        }
    }

    #[test]
    fn harden_skill_maps_known_dimensions() {
        assert_eq!(harden_skill_for("security"), "/security-audit");
        assert_eq!(harden_skill_for("types"), "/harden-types");
        assert_eq!(harden_skill_for("a11y"), "/audit-a11y");
        // Unknown dimension falls back to the general audit.
        assert_eq!(harden_skill_for("nope"), "/audit");
    }

    #[test]
    fn task_description_includes_grade_skill_and_provenance() {
        let r = minimal_reading();
        let desc = task_description(&r, "/security-audit");
        assert!(desc.contains("security"), "should include dimension");
        assert!(desc.contains("**C**"), "should include grade");
        assert!(desc.contains("/security-audit"), "should restate the skill");
        assert!(
            desc.contains("Readiness Scorecard reading"),
            "should include provenance footer"
        );
    }

    #[test]
    fn task_description_renders_evidence_with_location() {
        use crate::store::insight::FindingLocation;
        use crate::store::scorecard::ScorecardEvidence;
        let mut r = minimal_reading();
        r.findings = vec![ScorecardEvidence {
            detail: "trusts req.body".to_string(),
            location: Some(FindingLocation {
                file: "src/a.ts".to_string(),
                start_line: Some(14),
                end_line: None,
                symbol: None,
            }),
        }];
        let desc = task_description(&r, "/security-audit");
        assert!(desc.contains("trusts req.body"));
        assert!(desc.contains("src/a.ts:14"));
    }

    #[test]
    fn wire_str_serializes_dimension_to_wire_string() {
        assert_eq!(wire_str(&ScorecardDimension::ErrorHandling), "error-handling");
        assert_eq!(wire_str(&ScorecardDimension::DocsCi), "docs-ci");
    }
}
