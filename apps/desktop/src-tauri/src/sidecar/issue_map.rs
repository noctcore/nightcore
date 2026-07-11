//! The thin issue-map commands: `preview_issue_map` (build the plan, run the ONE LLM
//! pass, discover the prior map, return the full preview) and `export_issue_map`
//! (single-flight, ensure labels → create parent → sequential create+attach → optional
//! supersede-close). Both are `async` + `spawn_blocking` because they shell to `gh`
//! (and `claude -p`) — a sync command would freeze the WKWebView.
//!
//! Concurrency (§3.9, §10.2): guarded by a DEDICATED `issue_map_in_flight` single-flight
//! keyed by `run_id`, NOT the project-root mutation lease. Issue/sub-issue creation is a
//! pure GitHub-API operation that never touches the working tree or index, so it cannot
//! collide with merge/commit; holding the root lease across ~100 sequential calls would
//! needlessly refuse every concurrent merge/commit. Deliberate deviation from the
//! "every GitHub mutation takes the root lease" mnemonic (issue_triage precedent).

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::git::gh::GH_BINARY;
use crate::project::Project;
use crate::settings::SettingsStore;
use crate::store::harness::HarnessStore;
use crate::store::insight::InsightStore;
use crate::store::scorecard::ScorecardStore;
use crate::task::now_ms;
use crate::workflow::issue_map::{
    build_enforce_plan, build_insight_plan, build_scorecard_plan, export_map, find_prior_map,
    format_utc_datetime, generate, render_parent_body, GroupCount, IssueMapPlan, IssueMapPreview,
    IssueMapResult, Narrative, ScanKind, GH_TIMEOUT,
};
use crate::workflow::merge::{require_project, TaskLease};

/// The Tauri event channel the dialog consumes for `created k / N` progress.
const ISSUE_MAP_EVENT: &str = "nc:issue-map";

/// Soft preview warning threshold (no hard cap, §3.9): above this the dialog warns.
const SOFT_WARN: u32 = 50;

/// Per-`run_id` single-flight so a double-fire can't run the whole export twice.
fn issue_map_in_flight() -> &'static Mutex<HashSet<String>> {
    static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Build the deterministic plan for a completed run of `kind`, reading the store
/// VERBATIM. Errors if the run is unknown or not `completed`.
fn build_plan(app: &AppHandle, kind: ScanKind, run_id: &str) -> Result<IssueMapPlan, String> {
    match kind {
        ScanKind::Insight => {
            let store = app
                .try_state::<InsightStore>()
                .ok_or_else(|| "insight store unavailable".to_string())?;
            let run = store
                .get(run_id)
                .ok_or_else(|| format!("no insight run {run_id}"))?;
            require_completed(&run.status)?;
            Ok(build_insight_plan(&run))
        }
        ScanKind::Scorecard => {
            let store = app
                .try_state::<ScorecardStore>()
                .ok_or_else(|| "scorecard store unavailable".to_string())?;
            let run = store
                .get(run_id)
                .ok_or_else(|| format!("no scorecard run {run_id}"))?;
            require_completed(&run.status)?;
            Ok(build_scorecard_plan(&run))
        }
        ScanKind::Enforce => {
            let store = app
                .try_state::<HarnessStore>()
                .ok_or_else(|| "harness store unavailable".to_string())?;
            let run = store
                .get(run_id)
                .ok_or_else(|| format!("no harness run {run_id}"))?;
            require_completed(&run.status)?;
            Ok(build_enforce_plan(&run))
        }
    }
}

fn require_completed(status: &str) -> Result<(), String> {
    if status == "completed" {
        Ok(())
    } else {
        Err(format!(
            "this run is `{status}`, not completed — only a completed scan can be exported"
        ))
    }
}

/// The configured issue-label prefix (`issue_label_prefix`, default `"nc:"`), so the map's
/// `nc:*` labels honor the same prefix as the two-way sync writeback (#97 — the export used
/// to hardcode `nc:`).
fn label_prefix(app: &AppHandle) -> String {
    app.state::<SettingsStore>()
        .with_settings(|s| s.label_prefix().to_string())
}

/// Guard that the run's project is still the active one, and return it (its root is the
/// `gh` cwd that resolves `{owner}`/`{repo}`). Never post to a repo the user left.
fn guard_active_project(app: &AppHandle, plan: &IssueMapPlan) -> Result<Project, String> {
    let project = require_project(app)?;
    if project.path != plan.project_path {
        return Err(
            "the run's project is no longer active — reopen it before exporting".to_string(),
        );
    }
    Ok(project)
}

/// Build the full preview payload (§3.1) — the human gate's bytes.
#[tauri::command]
pub async fn preview_issue_map(
    app: AppHandle,
    scan_kind: String,
    run_id: String,
) -> Result<IssueMapPreview, String> {
    tauri::async_runtime::spawn_blocking(move || preview_blocking(&app, &scan_kind, &run_id))
        .await
        .map_err(|e| format!("previewing the issue map failed to run: {e}"))?
}

fn preview_blocking(
    app: &AppHandle,
    scan_kind: &str,
    run_id: &str,
) -> Result<IssueMapPreview, String> {
    let kind = ScanKind::from_wire(scan_kind)?;
    let plan = build_plan(app, kind, run_id)?;
    if plan.total() == 0 {
        return Err("this run has no exportable findings".to_string());
    }
    let project = guard_active_project(app, &plan)?;
    let dir = Path::new(&project.path);
    // The label prefix the export uses (honors `issue_label_prefix`, so map + sync agree).
    let prefix = label_prefix(app);

    // Mint the ISO timestamp ONCE here and thread it to the write command (preview ==
    // post, §3.8/§10.6).
    let generated_at = format_utc_datetime(now_ms());
    let (narrative, narrative_ok) = generate(&plan);
    // Prior-map discovery is a best-effort network read — a hiccup must not sink the
    // preview (export re-probes gh and surfaces a real failure loudly).
    let supersedes = find_prior_map(dir, GH_BINARY, kind, &prefix, GH_TIMEOUT).unwrap_or_else(|e| {
        tracing::warn!(target: "nightcore::issue_map", error = %e, "prior-map discovery failed (preview continues without a supersede)");
        None
    });

    let total = plan.total();
    let parent_body =
        render_parent_body(&plan, &narrative, &generated_at, supersedes.as_ref(), None);
    let groups: Vec<GroupCount> = plan.group_counts();
    let soft_warning = (total > SOFT_WARN).then(|| {
        format!(
            "This will open {} issues ({total} sub-issues + 1 parent) on GitHub.",
            total + 1
        )
    });

    Ok(IssueMapPreview {
        scan_kind: kind.wire().to_string(),
        run_id: run_id.to_string(),
        generated_at,
        parent_title: plan.parent_title(),
        parent_body,
        sub_issues: plan.sub_previews(),
        total,
        groups,
        supersedes,
        soft_warning,
        narrative,
        narrative_ok,
    })
}

/// Mint the map on GitHub (§3.2). Takes back only the deterministic inputs + the
/// previewed narrative + the once-minted `generated_at`, re-derives everything else
/// Rust-side. Emits `nc:issue-map` progress; the return is the terminal result.
#[tauri::command]
pub async fn export_issue_map(
    app: AppHandle,
    scan_kind: String,
    run_id: String,
    generated_at: String,
    narrative: Narrative,
    close_superseded: bool,
) -> Result<IssueMapResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        export_blocking(
            &app,
            &scan_kind,
            &run_id,
            &generated_at,
            &narrative,
            close_superseded,
        )
    })
    .await
    .map_err(|e| format!("exporting the issue map failed to run: {e}"))?
}

fn export_blocking(
    app: &AppHandle,
    scan_kind: &str,
    run_id: &str,
    generated_at: &str,
    narrative: &Narrative,
    close_superseded: bool,
) -> Result<IssueMapResult, String> {
    let kind = ScanKind::from_wire(scan_kind)?;
    // Dedicated single-flight (NOT the root lease, §10.2).
    let _lease = TaskLease::acquire(issue_map_in_flight(), run_id).ok_or_else(|| {
        "an export is already running for this run — wait for it to finish".to_string()
    })?;

    let plan = build_plan(app, kind, run_id)?;
    if plan.total() == 0 {
        return Err("this run has no exportable findings".to_string());
    }
    let project = guard_active_project(app, &plan)?;
    let dir = Path::new(&project.path);
    let prefix = label_prefix(app);

    let supersedes = find_prior_map(dir, GH_BINARY, kind, &prefix, GH_TIMEOUT).unwrap_or_else(|e| {
        tracing::warn!(target: "nightcore::issue_map", error = %e, "prior-map discovery failed (export continues without a supersede)");
        None
    });

    tracing::info!(target: "nightcore", run_id, kind = kind.wire(), total = plan.total(), "exporting issue map to GitHub");
    export_map(
        dir,
        GH_BINARY,
        &prefix,
        &plan,
        narrative,
        generated_at,
        supersedes.as_ref(),
        close_superseded,
        GH_TIMEOUT,
        |created, total| {
            let _ = app.emit(
                ISSUE_MAP_EVENT,
                json!({ "type": "progress", "runId": run_id, "created": created, "total": total }),
            );
        },
    )
}
