//! Issue Triage commands (web → Rust): the read-only `gh` seams that populate the
//! list + detail views, the validation start/cancel lifecycle, and the small private
//! helpers those commands share with the reader-side event handling.

use tauri::{AppHandle, Manager, State};

use crate::contracts::{
    EffortLevel, IssueComment, IssueLinkedPrContext, IssuePrState, SurfaceCommand,
};
use crate::project::ProjectStore;
use crate::store::insight::InsightUsage;
use crate::store::issue_triage::{
    IssueValidationRun, IssueValidationStore, StoredIssueValidationResult,
};
use crate::store::run_store::Edit;
use crate::task::TaskKind;
use crate::workflow::issue_triage::{
    fetch_issue_detail, fetch_linked_pr_diff, list_open_issues, IssueDetail, IssueSummary,
};
use crate::workflow::merge::require_project;

use crate::sidecar::scan::{
    begin_scan_run, dispatch_scan_command, scan_lifecycle_commands, ScanRunInit,
};

// The three store-agnostic lifecycle commands (list / get / delete). Cancel is
// HAND-WRITTEN below (the macro's cancel-less arm): a validation cancel must mark the
// persisted run failed("cancelled") BEFORE dispatching the engine cancel, because
// `start_issue_validation`'s setup window (the bounded `gh` diff fetch) runs before the
// engine ever hears about the run.
scan_lifecycle_commands! {
    store: IssueValidationStore,
    run: IssueValidationRun,
    list: list_issue_validations,
    get: get_issue_validation,
    delete: delete_issue_validation,
    item: "issue validation",
}

/// Stamp `failed(<reason>)` on a run ONLY while it is still `running` — the idempotent
/// mark shared by [`cancel_issue_validation`] and the `issue-validation-failed` arm.
/// Returns whether THIS call stamped it. A run that already settled (completed, or
/// failed("cancelled") by the cancel command) is left untouched.
pub(super) fn mark_failed_if_running(
    store: &IssueValidationStore,
    run_id: &str,
    reason: &str,
) -> bool {
    store
        .edit_run(run_id, |run| {
            if run.status != "running" {
                return Ok(Edit::Skip(false));
            }
            run.status = "failed".to_string();
            run.error = Some(reason.to_string());
            Ok(Edit::Commit(true))
        })
        .map(|(stamped, _)| stamped)
        .unwrap_or(false)
}

/// The pre-dispatch re-check closing `start_issue_validation`'s cancel window: the diff
/// fetch can block for up to the bounded `gh` timeout, and a cancel landing in that
/// window has no engine session to abort — it marks the store run failed("cancelled")
/// instead. Refuse the dispatch unless the run is still `running`. Pure — unit-tested.
pub(super) fn check_still_running_before_dispatch(status: Option<&str>) -> Result<(), String> {
    match status {
        Some("running") => Ok(()),
        Some(status) => Err(format!(
            "the validation was cancelled before dispatch (status: {status})"
        )),
        None => Err("the validation run was deleted before dispatch".to_string()),
    }
}

/// Map a validation verdict to the suggested board task kind. A complex/very-complex
/// FEATURE request becomes a `Decompose` (it needs breaking down first); everything
/// else — bugs, simple features, questions — becomes a `Build`. Pure — unit-tested.
pub(super) fn task_kind_for(result: &StoredIssueValidationResult) -> TaskKind {
    let complex = matches!(
        result.estimated_complexity.as_deref(),
        Some("complex") | Some("very_complex")
    );
    if result.issue_kind == "feature_request" && complex {
        TaskKind::Decompose
    } else {
        TaskKind::Build
    }
}

/// List the active project's OPEN GitHub issues (+ linked-PR badges). Runs off the UI
/// thread — the `gh` spawn talks to the network.
#[tauri::command]
pub async fn list_project_issues(app: AppHandle) -> Result<Vec<IssueSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = require_project(&app)?;
        list_open_issues(std::path::Path::new(&project.path))
    })
    .await
    .map_err(|e| format!("listing issues failed to run: {e}"))?
}

/// Fetch one issue's body + first page of comments for the detail view. Off the UI
/// thread (network `gh` spawn).
#[tauri::command]
pub async fn fetch_project_issue_detail(
    app: AppHandle,
    issue_number: u64,
) -> Result<IssueDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = require_project(&app)?;
        fetch_issue_detail(std::path::Path::new(&project.path), issue_number)
    })
    .await
    .map_err(|e| format!("reading the issue failed to run: {e}"))?
}

/// Start a read-only validation of one GitHub issue against the active project. Persists
/// the run (`running`), pre-fetches each OPEN linked PR's diff via a bounded `gh` seam
/// OFF the UI thread (so the sidecar's validation session stays read-only/offline),
/// dispatches `start-issue-validation` with the diffs inline, and returns the `runId`
/// the `issue-validation-*` events correlate by. All GitHub-sourced text (`issue_title`
/// / `issue_body` / comments / linked-PR titles) is untrusted; the engine wraps it in
/// `untrusted_block`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_issue_validation(
    app: AppHandle,
    projects: State<'_, ProjectStore>,
    issue_store: State<'_, IssueValidationStore>,
    issue_number: u64,
    issue_title: String,
    issue_body: String,
    issue_author: String,
    labels: Vec<String>,
    comments: Vec<IssueComment>,
    linked_prs: Vec<IssueLinkedPrContext>,
    model: Option<String>,
    effort: Option<EffortLevel>,
) -> Result<String, String> {
    if issue_number == 0 {
        return Err("enter a valid issue number (a positive integer)".to_string());
    }
    let ScanRunInit {
        project_path,
        run_id,
        model: model_str,
        now,
    } = begin_scan_run(
        projects.active(),
        // There is no multi-item selection for a validation; the only gate is a project.
        false,
        "",
        "no active project to validate an issue against",
        model.as_deref(),
    )?;

    // Persist the run as `running` up front so it shows immediately. Single-flight PER
    // ISSUE: reject a second concurrent validation of the SAME issue (a stray re-click)
    // instead of launching another paid session; validations of DIFFERENT issues may run
    // concurrently.
    let run = IssueValidationRun {
        id: run_id.clone(),
        project_path: project_path.clone(),
        issue_number,
        issue_title: issue_title.clone(),
        status: "running".to_string(),
        model: model_str,
        created_at: now,
        updated_at: now,
        cost_usd: 0.0,
        duration_ms: 0,
        usage: InsightUsage::default(),
        result: None,
        error: None,
        linked_task_id: None,
        viewed_at: None,
        posted_at: None,
        posted_comment_url: None,
    };
    issue_store.upsert_if_idle_when(
        &run,
        |r| r.issue_number == issue_number,
        &format!(
            "a validation for issue #{issue_number} is already running — wait for it to finish or cancel it first"
        ),
    )?;

    // Pre-fetch each OPEN linked PR's diff off the UI thread (bounded `gh`, best-effort).
    // Rust owns this network read so the sidecar's validation session never touches the
    // network. A closed/merged PR carries no diff (only an OPEN PR can still "fix" the
    // issue — the analysis reasons about wait_for_merge on those).
    let fetch_path = project_path.clone();
    let prs_for_fetch = linked_prs.clone();
    let augmented_prs = tauri::async_runtime::spawn_blocking(move || {
        let dir = std::path::Path::new(&fetch_path);
        prs_for_fetch
            .into_iter()
            .map(|mut pr| {
                if matches!(pr.state, IssuePrState::Open) {
                    pr.diff = fetch_linked_pr_diff(dir, pr.number);
                }
                pr
            })
            .collect::<Vec<IssueLinkedPrContext>>()
    })
    .await
    .map_err(|e| format!("linked-PR diff fetch failed to run: {e}"));

    let linked_prs = match augmented_prs {
        Ok(prs) => prs,
        Err(msg) => {
            let _ = issue_store.mutate(&run_id, |r| {
                r.status = "failed".to_string();
                r.error = Some(msg.clone());
            });
            return Err(msg);
        }
    };

    // Cancel-during-setup guard: a cancel (or delete) that landed during the blocking
    // diff fetch already settled the run; dispatching anyway would launch a paid session
    // the UI shows as cancelled.
    check_still_running_before_dispatch(issue_store.get(&run_id).map(|r| r.status).as_deref())?;

    let command = SurfaceCommand::StartIssueValidation {
        run_id: run_id.clone(),
        project_path,
        issue_number,
        issue_title,
        issue_body,
        issue_author,
        labels,
        comments,
        linked_prs,
        model,
        effort,
        max_turns: None,
        max_budget_usd: None,
    };
    dispatch_scan_command(&app, "issue-triage", &run_id, command, |msg| {
        issue_store
            .mutate(&run_id, |r| {
                r.status = "failed".to_string();
                r.error = Some(msg.to_string());
            })
            .map(|_| ())
    })
    .await?;

    tracing::info!(target: "nightcore", run_id = %run_id, issue_number, "issue validation started");
    Ok(run_id)
}

/// Cancel an in-flight validation. Marks the store run failed("cancelled") FIRST (so the
/// start path's pre-dispatch re-check aborts instead of dispatching), then dispatches the
/// engine cancel for the already-dispatched case.
#[tauri::command]
pub async fn cancel_issue_validation(
    app: AppHandle,
    issue_store: State<'_, IssueValidationStore>,
    run_id: String,
) -> Result<(), String> {
    let stamped = mark_failed_if_running(&issue_store, &run_id, "cancelled");
    if stamped {
        tracing::info!(target: "nightcore", run_id = %run_id, "issue validation cancelled (store marked)");
    }
    let provider = app.state::<std::sync::Arc<crate::provider::SidecarProvider>>();
    provider
        .dispatch_command(SurfaceCommand::CancelIssueValidation {
            run_id: run_id.clone(),
        })
        .await
}

/// Stamp a validation as viewed-now (drives the "new since you looked" affordance).
#[tauri::command]
pub fn mark_issue_validation_viewed(
    issue_store: State<'_, IssueValidationStore>,
    run_id: String,
) -> Result<IssueValidationRun, String> {
    issue_store.mark_viewed(&run_id)
}
