//! [`pr_status`] — the read-only `gh pr view` snapshot command. No lease, no
//! mutation; on-demand only (mount + manual refresh, no polling daemon).

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use super::view::{fetch_pr_view_with, require_pr_number, GH_VIEW_TIMEOUT};
use super::PrStatus;
use crate::store::TaskStore;
use crate::workflow::merge::require_project;
use crate::workflow::pr::GH_BINARY;
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
