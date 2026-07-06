//! The human-gated actions on a settled validation: previewing/posting the verdict as a
//! GitHub issue comment (a mutation, per-root-lease guarded) and converting the verdict
//! into a board task (idempotent, untrusted-fenced description).

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::infra::untrusted::untrusted_block;
use crate::sidecar::convert::convert_to_task;
use crate::sidecar::ISSUE_TRIAGE_EVENT;
use crate::store::issue_triage::{
    IssueValidationRun, IssueValidationStore, StoredIssueValidationResult,
};
use crate::store::TaskStore;
use crate::task::{sanitize_minted_title, Task, TASK_EVENT};
use crate::workflow::issue_triage::{
    build_issue_comment_body, format_utc_date, post_issue_comment,
};
use crate::workflow::merge::{acquire_root_lease, require_project};

use super::task_kind_for;

/// Build the EXACT comment markdown the post action would send, for the UI's confirm
/// dialog. Built by the same [`build_issue_comment_body`] the post path uses, over the
/// same stored verdict + validation date — so the preview is byte-identical to the post.
#[tauri::command]
pub fn preview_issue_comment(
    issue_store: State<'_, IssueValidationStore>,
    run_id: String,
) -> Result<String, String> {
    let run = issue_store
        .get(&run_id)
        .ok_or_else(|| format!("no validation run {run_id}"))?;
    let result = run
        .result
        .ok_or_else(|| "this validation has no verdict to post yet".to_string())?;
    Ok(build_issue_comment_body(
        &result,
        &run.model,
        &format_utc_date(run.updated_at),
    ))
}

/// Post the validation verdict as a GitHub issue comment (a MUTATION). The human gate is
/// the UI's confirm dialog; here we guard with the per-root mutation lease, REBUILD the
/// body from the stored verdict (never a body from the web — so the posted text is
/// exactly what the preview showed), and POST it atomically. Runs off the UI thread.
#[tauri::command]
pub async fn post_issue_validation_comment(app: AppHandle, run_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || post_issue_comment_blocking(&app, &run_id))
        .await
        .map_err(|e| format!("posting the comment failed to run: {e}"))?
}

/// The blocking body of [`post_issue_validation_comment`]: re-acquire the store, load the
/// run, guard the active project + the root-mutation lease, rebuild the body, post, and
/// stamp the posted marker.
fn post_issue_comment_blocking(app: &AppHandle, run_id: &str) -> Result<(), String> {
    let store = app
        .try_state::<IssueValidationStore>()
        .ok_or_else(|| "issue-validation store unavailable".to_string())?;
    let run = store
        .get(run_id)
        .ok_or_else(|| format!("no validation run {run_id}"))?;
    let result = run
        .result
        .as_ref()
        .ok_or_else(|| "this validation has no verdict to post yet".to_string())?;

    // The active project's root is the `gh` cwd (it resolves `{owner}`/`{repo}`). Guard
    // that the run's project is still the active one — never post to a repo the user
    // switched away from.
    let project = require_project(app)?;
    if project.path != run.project_path {
        return Err(
            "the validation's project is no longer active — reopen it before posting".to_string(),
        );
    }

    // Per-root mutation lease: posting mutates the shared project (a GitHub write from its
    // root), so serialize it against the other root mutations (merge / commit / pull-base).
    let _lease = acquire_root_lease(std::path::Path::new(&project.path), "posting the comment")?;

    let body = build_issue_comment_body(result, &run.model, &format_utc_date(run.updated_at));
    tracing::info!(target: "nightcore", run_id, issue_number = run.issue_number, "posting validation comment to GitHub");
    let comment_url =
        post_issue_comment(std::path::Path::new(&project.path), run.issue_number, &body)?;

    // The post SUCCEEDED — stamp the posted marker best-effort (a store hiccup must not
    // turn a landed post into a failure).
    if let Err(e) = store.mark_posted(run_id, comment_url) {
        tracing::warn!(target: "nightcore", run_id, error = %e, "failed to record posted marker (post already succeeded)");
    }
    Ok(())
}

/// Convert a validation verdict into a board task. Idempotent: if the run already links a
/// live task, that task is returned instead of a duplicate. Suggests a `kind`
/// (complex feature → Decompose, else Build); the model-derived verdict is fenced as
/// untrusted in the description.
#[tauri::command]
pub fn convert_issue_validation_to_task(
    app: AppHandle,
    store: State<'_, TaskStore>,
    issue_store: State<'_, IssueValidationStore>,
    run_id: String,
) -> Result<Task, String> {
    let run = issue_store
        .get(&run_id)
        .ok_or_else(|| format!("no validation run {run_id}"))?;
    let result = run
        .result
        .as_ref()
        .ok_or_else(|| "this validation has no verdict to convert yet".to_string())?;

    let mut task = Task::new(
        sanitize_minted_title(&run.issue_title, "Untitled issue"),
        validation_description(&run, result),
    );
    task.kind = task_kind_for(result);
    task.source_ref = Some(format!("issue-triage:{run_id}"));

    let stamped = convert_to_task(
        &store,
        run.linked_task_id.as_deref(),
        task,
        |task_id| issue_store.link_validation_task(&run_id, task_id),
        |task_id| issue_store.set_validation_linked_task(&run_id, task_id),
    )?;

    let _ = app.emit(TASK_EVENT, &stamped);
    let _ = app.emit(
        ISSUE_TRIAGE_EVENT,
        json!({
            "type": "issue-validation-converted",
            "runId": run_id,
            "issueNumber": run.issue_number,
            "taskId": stamped.id,
        }),
    );
    tracing::info!(target: "nightcore", task_id = %stamped.id, run_id = %run_id, "issue validation converted to task");
    Ok(stamped)
}

/// Build the markdown task description from a validation verdict + provenance. The whole
/// verdict — including the untrusted issue title and the model-derived reasoning/plan —
/// is wrapped in an [`untrusted_block`] so the write-capable Build agent treats it as
/// DATA, not instructions; only the trusted issue-number provenance footer sits outside.
pub(super) fn validation_description(
    run: &IssueValidationRun,
    result: &StoredIssueValidationResult,
) -> String {
    let mut body = String::new();
    body.push_str(&format!(
        "Issue #{}: {}\n\n",
        run.issue_number, run.issue_title
    ));
    body.push_str(&format!(
        "Verdict: {} | Kind: {} | Confidence: {}\n",
        result.verdict, result.issue_kind, result.confidence
    ));
    if let Some(complexity) = &result.estimated_complexity {
        body.push_str(&format!("Estimated complexity: {complexity}\n"));
    }
    body.push('\n');
    if !result.reasoning.trim().is_empty() {
        body.push_str(&result.reasoning);
        body.push_str("\n\n");
    }
    if let Some(plan) = &result.proposed_plan {
        if !plan.trim().is_empty() {
            body.push_str("Proposed plan:\n");
            body.push_str(plan);
            body.push_str("\n\n");
        }
    }
    if !result.related_files.is_empty() {
        body.push_str("Related files:\n");
        for file in &result.related_files {
            body.push_str(&format!("- {file}\n"));
        }
        body.push('\n');
    }
    if !result.missing_info.is_empty() {
        body.push_str("Missing information:\n");
        for item in &result.missing_info {
            body.push_str(&format!("- {item}\n"));
        }
        body.push('\n');
    }
    let mut out = untrusted_block(&body);
    out.push_str(&format!(
        "\n---\n_Created from an Issue Triage validation of issue #{}._\n",
        run.issue_number
    ));
    out
}
