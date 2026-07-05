//! [`pr_status`] / [`pr_status_by_number`] — the read-only `gh pr view`
//! snapshot commands. No lease, no mutation; on-demand only (mount + manual
//! refresh, no polling daemon). The task-scoped variant resolves the task's
//! recorded PR (and its worktree's unpushed count); the by-number variant
//! snapshots an ARBITRARY PR of the active project's repo.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use super::view::{fetch_pr_view_with, require_pr_number, GH_VIEW_TIMEOUT};
use super::PrStatus;
use crate::store::TaskStore;
use crate::git::gh::GH_BINARY;
use crate::workflow::merge::require_project;
use crate::worktree;

/// Fetch the live GitHub status of a task's PR (see [`PrStatus`]). Read-only —
/// NO lease — and on-demand only (the UI fetches on mount + manual refresh;
/// there is no polling daemon). Requires `task.pr_number`.
#[tauri::command]
pub async fn pr_status(app: AppHandle, id: String) -> Result<PrStatus, String> {
    // `gh` talks to the network (up to 60s) plus local git reads — blocking work
    // that must not run on the UI thread (the WKWebView rule).
    tauri::async_runtime::spawn_blocking(move || pr_status_blocking(&app, &id))
        .await
        .map_err(|e| format!("PR status failed to run: {e}"))?
}

/// The blocking body of `pr_status` (see `commit_task_blocking` for the
/// state-reacquisition rationale behind the owned `AppHandle`).
fn pr_status_blocking(app: &AppHandle, id: &str) -> Result<PrStatus, String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let project = require_project(app)?;
    let project_path = PathBuf::from(&project.path);
    let number = require_pr_number(&task)?;

    // cwd = the task's worktree when it still exists (config/credentials resolve
    // exactly as the user's own gh would there), else the project root — a
    // finalized/cleaned task can still refresh its PR state. The unpushed count
    // is local-only and needs the worktree; without one there is nothing
    // unpushed to report (a real 0). With one, an unresolvable upstream maps to
    // `None` ("cannot determine"), never a fake 0 — the UI keeps Push updates
    // armed on `None` because a `-u` re-push recreates a pruned upstream.
    let worktree_dir = worktree::worktree_path(&project_path, id);
    let (dir, unpushed_commits) = if worktree_dir.exists() {
        let unpushed = worktree::try_ahead_of_upstream(&worktree_dir).ok();
        (worktree_dir, unpushed)
    } else {
        (project_path, Some(0))
    };
    let view = fetch_pr_view_with(&dir, GH_BINARY, number, GH_VIEW_TIMEOUT)?;
    Ok(view.into_status(unpushed_commits))
}

/// Fetch the live GitHub status of an ARBITRARY pull request of the active
/// project by number (see [`PrStatus`]) — the workspace-scoped sibling of the
/// task-scoped [`pr_status`], for PRs no board task tracks. Same read-only
/// posture: NO lease, on-demand only.
#[tauri::command]
pub async fn pr_status_by_number(app: AppHandle, number: u64) -> Result<PrStatus, String> {
    // `gh` talks to the network (up to 60s) — blocking work that must not run
    // on the UI thread (the WKWebView rule).
    tauri::async_runtime::spawn_blocking(move || pr_status_by_number_blocking(&app, number))
        .await
        .map_err(|e| format!("PR status failed to run: {e}"))?
}

/// The blocking body of [`pr_status_by_number`]: resolve the active project
/// (its root is the `gh` cwd, which resolves the repo) and fetch. No task, so
/// no worktree lookup — the fetch runs from the project root.
fn pr_status_by_number_blocking(app: &AppHandle, number: u64) -> Result<PrStatus, String> {
    let project = require_project(app)?;
    let dir = PathBuf::from(&project.path);
    fetch_status_by_number(&dir, GH_BINARY, number, GH_VIEW_TIMEOUT)
}

/// The by-number fetch over the shared [`fetch_pr_view_with`] substrate.
/// Binary-parameterized — the fake-`gh` test seam, like the substrate itself.
/// `unpushed_commits` is ALWAYS `None`: an arbitrary PR has no task and thus no
/// local-branch mapping, so the count is genuinely undeterminable — `None`
/// ("cannot determine") is honest where a fake `Some(0)` would read as "all
/// pushed" in the UI.
pub(super) fn fetch_status_by_number(
    dir: &Path,
    binary: &str,
    number: u64,
    deadline: Duration,
) -> Result<PrStatus, String> {
    // Reject an invalid PR number before any probe/spawn (the sibling seams'
    // cheap-fail rule — see `fetch_pr_diff_with`).
    if number == 0 {
        return Err("enter a valid PR number (a positive integer)".to_string());
    }
    let view = fetch_pr_view_with(dir, binary, number, deadline)?;
    Ok(view.into_status(None))
}
