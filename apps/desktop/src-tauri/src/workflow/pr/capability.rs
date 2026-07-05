//! PR-capability probing: whether the active project can open PRs — `gh` on
//! PATH plus an `origin` remote. Booleans only; the remote URL may carry
//! credentials and never crosses the IPC boundary.

use serde::Serialize;
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;

use crate::git::gh::GH_BINARY;
use crate::workflow::merge::require_project;
use crate::worktree;

/// Whether the machine can create PRs for the active project: `gh` on PATH and
/// an `origin` remote configured. Sent to the UI so the Create PR button gates
/// honestly instead of failing on click. Booleans ONLY — the raw remote URL can
/// embed credentials (`https://user:token@host/…`) and must never cross the IPC
/// boundary into the renderer.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrSupport.ts"))]
pub struct PrSupport {
    /// `which`-probed presence of the GitHub CLI.
    pub gh_installed: bool,
    /// Whether the project has an `origin` remote configured (the URL itself
    /// stays on the Rust side — it may carry embedded credentials).
    pub has_remote: bool,
}

/// Probe PR capability for the active project (see [`PrSupport`]). The `id` is
/// part of the shared command contract (the bridge always sends the task id);
/// the probe itself is project-scoped. Runs off the UI thread — the remote read
/// spawns `git`.
#[tauri::command]
pub async fn pr_support(app: AppHandle, id: String) -> Result<PrSupport, String> {
    tauri::async_runtime::spawn_blocking(move || pr_support_blocking(&app, &id))
        .await
        .map_err(|e| format!("PR support probe failed to run: {e}"))?
}

/// The blocking body of `pr_support` (see `commit_task_blocking` for the
/// state-reacquisition rationale behind the owned `AppHandle`).
fn pr_support_blocking(app: &AppHandle, id: &str) -> Result<PrSupport, String> {
    tracing::debug!(target: "nightcore::pr", task_id = %id, "probing PR support");
    let project = require_project(app)?;
    let project_path = std::path::PathBuf::from(&project.path);
    Ok(PrSupport {
        gh_installed: which::which(GH_BINARY).is_ok(),
        has_remote: worktree::remote_url(&project_path).is_some(),
    })
}
