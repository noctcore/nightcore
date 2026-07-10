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

use std::ffi::OsStr;
use std::path::{Component, PathBuf};

use tauri::{AppHandle, Manager};

use crate::git::gh::GH_BINARY;
use crate::store::TaskStore;
use crate::task::Task;
use crate::workflow::merge::require_project;
use crate::workflow::trust::{
    build_report, post_trust_comment_with, render_for_github, render_markdown, require_pr_number,
    TrustReport, GH_COMMENT_TIMEOUT,
};

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

/// Render the Trust Report and write it to a user-chosen `*.md` path (PR 2, §3.7).
///
/// `dest_path` comes from the web `save()` native dialog, so it is USER-CHOSEN and
/// untrusted: it is validated ([`validate_export_dest`]) to be absolute and to not
/// target any `.nightcore/` directory before any write, so a receipt can never
/// clobber the on-disk store (constraint §4.2). The backend renders the ONE
/// canonical markdown (`render_markdown` — the local-export flavor, an `#` title,
/// no GitHub header/footer) and writes it atomically via `store::atomic::write_atomic`
/// (the backend-writes-the-artifact idiom of `apply_harness_artifact`). Async +
/// `spawn_blocking` for the file reads + write (the sync-command WKWebView-freeze
/// trap, `reference_tauri_command_threading`).
#[tauri::command]
pub async fn write_trust_report(
    app: AppHandle,
    task_id: String,
    dest_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = validate_export_dest(&dest_path)?;
        let report = build_blocking(&app, &task_id)?;
        let markdown = render_markdown(&report);
        crate::store::write_atomic(&dest, markdown.as_bytes())
            .map_err(|e| format!("failed to write trust report to {}: {e}", dest.display()))
    })
    .await
    .map_err(|e| format!("write trust report failed to run: {e}"))?
}

/// Attach the Trust Report to the task's pull request as a conversation comment
/// (PR 3, §3.9). Renders the ONE canonical markdown in its `for_github` flavor
/// (the house header/footer + GitHub-safe fencing — NEVER the plain export
/// renderer) and posts it via `gh api …/issues/{n}/comments` (the
/// `post_push_comment_with` idiom). FAILS loudly when the task has no PR — never a
/// silent no-op (`require_pr_number`). Human-gated on the web side (the Trust
/// band's ConfirmDialog); the command never self-gates
/// (`pr_review_post::post_review_to_github`'s posture). It is a SEPARATE action
/// from create/merge and takes NO `pr_in_flight` lease (§3.9) — its own comment
/// deadline bounds it, and the web action's pending guard single-flights it.
///
/// `gh` runs in the PROJECT ROOT (always present — the worktree may be gone
/// post-merge); `{owner}/{repo}` resolve from that repo's origin remote, so no raw
/// URL crosses IPC. Async + `spawn_blocking` for the file reads + network `gh`
/// spawn (the sync-command WKWebView-freeze trap).
#[tauri::command]
pub async fn attach_trust_report_to_pr(app: AppHandle, task_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || attach_blocking(&app, &task_id))
        .await
        .map_err(|e| format!("attach trust report failed to run: {e}"))?
}

/// The blocking body of [`attach_trust_report_to_pr`]: resolve the PR number +
/// project root, build the report, render `for_github`, and post the comment.
fn attach_blocking(app: &AppHandle, task_id: &str) -> Result<(), String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or("task store unavailable")?;
    let task: Task = store
        .get(task_id)
        .ok_or_else(|| format!("no task with id {task_id}"))?;
    // Fail loudly when there is no PR to attach to (never a silent no-op).
    let pr_number = require_pr_number(&task)?;
    let project = require_project(app)?;
    let dir = PathBuf::from(&project.path);
    let tasks_dir = store.tasks_dir();
    let ledger = ledger_path(app, task_id);
    let report = build_report(&task, &ledger, &tasks_dir);
    let body = render_for_github(&report);
    post_trust_comment_with(&dir, GH_BINARY, pr_number, &body, GH_COMMENT_TIMEOUT)
}

/// Validate a user-chosen export path (§3.7): it must be ABSOLUTE (the native
/// save dialog returns one) and must not descend through any `.nightcore/`
/// directory — the receipt is a user artifact and is NEVER allowed to land inside
/// the on-disk store (constraint §4.2). Returns the normalized `PathBuf` to write.
fn validate_export_dest(dest_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(dest_path);
    if !path.is_absolute() {
        return Err(format!("export path must be absolute: {dest_path}"));
    }
    if path
        .components()
        .any(|c| matches!(c, Component::Normal(name) if name == OsStr::new(".nightcore")))
    {
        return Err("refusing to write a Trust Report inside a .nightcore directory".to_string());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::validate_export_dest;

    #[test]
    fn rejects_a_relative_export_path() {
        assert!(validate_export_dest("reports/trust.md").is_err());
        assert!(validate_export_dest("./trust.md").is_err());
        assert!(validate_export_dest("").is_err());
    }

    #[test]
    fn rejects_a_path_inside_a_nightcore_directory() {
        assert!(validate_export_dest("/home/dev/proj/.nightcore/trust.md").is_err());
        assert!(validate_export_dest("/home/dev/proj/.nightcore/ledger/x.md").is_err());
    }

    #[test]
    fn accepts_an_absolute_path_outside_nightcore() {
        let dest = validate_export_dest("/home/dev/Desktop/trust-report.md")
            .expect("an absolute non-.nightcore path is a valid export destination");
        assert_eq!(
            dest,
            std::path::PathBuf::from("/home/dev/Desktop/trust-report.md")
        );
        // A `.nightcore`-lookalike segment (not the exact dir name) is NOT rejected.
        assert!(validate_export_dest("/home/dev/my.nightcore-notes/trust.md").is_ok());
    }
}
