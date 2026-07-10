//! The Trust Report commands (wayfinder #91, PR 1) — thin shells over
//! `crate::workflow::trust`.
//!
//! Each resolves the active project's ledger path + the task store's tasks dir,
//! loads the task, and calls the pure `build_report` aggregator (then a renderer
//! for the markdown variant). The bodies read files (task JSON, ledger NDJSON,
//! transcript), so they run on the blocking pool via `spawn_blocking` — a
//! synchronous `#[tauri::command]` would freeze the WKWebView for the read
//! (the `commit_task` / `read_transcript` recipe, `reference_tauri_command_threading`).
//!
//! State is re-acquired via `try_state` inside the 'static blocking closure (the
//! `State<'_>` guard can't cross into it), so an unmanaged store fails gracefully.
//! The report is COMPUTED ON DEMAND and never persisted (locked decision 4).

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::store::TaskStore;
use crate::task::Task;
use crate::workflow::trust::{build_report, render_for_github, render_markdown, TrustReport};

/// The active project's per-task ledger path (`resolve_ledger_path` idiom). `None`
/// when no project is active — the aggregator then reads an absent ledger (empty
/// records), degrading gracefully rather than erroring.
fn ledger_path(app: &AppHandle, task_id: &str) -> PathBuf {
    crate::sidecar::resolve_ledger_path(app, task_id)
        .map(PathBuf::from)
        // A path that cannot exist ⇒ `read_records` yields no records (the
        // pre-recorder / no-project shape). Never joined against a real dir.
        .unwrap_or_else(|| PathBuf::from(""))
}

/// Resolve the task + inputs and build the report on the blocking pool.
fn build_blocking(app: &AppHandle, task_id: &str) -> Result<TrustReport, String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or("task store unavailable")?;
    let task: Task = store
        .get(task_id)
        .ok_or_else(|| format!("no task with id {task_id}"))?;
    let tasks_dir = store.tasks_dir();
    let ledger = ledger_path(app, task_id);
    Ok(build_report(&task, &ledger, &tasks_dir))
}

/// Compute the structured Trust Report for a task (the drawer renders it natively).
#[tauri::command]
pub async fn trust_report(app: AppHandle, task_id: String) -> Result<TrustReport, String> {
    tauri::async_runtime::spawn_blocking(move || build_blocking(&app, &task_id))
        .await
        .map_err(|e| format!("trust report failed to run: {e}"))?
}

/// Render the Trust Report as canonical markdown — `for_github` wraps it with the
/// house header/footer + GitHub-safe fencing (export + PR + preview all use this).
#[tauri::command]
pub async fn trust_report_markdown(
    app: AppHandle,
    task_id: String,
    for_github: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let report = build_blocking(&app, &task_id)?;
        Ok(if for_github {
            render_for_github(&report)
        } else {
            render_markdown(&report)
        })
    })
    .await
    .map_err(|e| format!("trust report markdown failed to run: {e}"))?
}
