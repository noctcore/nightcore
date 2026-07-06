//! [`pull_base_ff`] — fast-forward-ONLY update of the base branch on the project
//! root (`git fetch` + `git merge --ff-only`; a non-ff base surfaces git's error
//! verbatim, never a real merge). Guarded by the shared project-root lease.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use super::view::{fetch_pr_view_with, require_pr_number, GH_VIEW_TIMEOUT};
use crate::git::gh::GH_BINARY;
use crate::git::validate_ref;
use crate::store::TaskStore;
use crate::task::Task;
use crate::workflow::merge::{acquire_root_lease, require_project};
use crate::worktree;

/// Fast-forward-only pull of the task's base branch on the PROJECT ROOT, for
/// after a remote merge: `git fetch origin <base>` + `git merge --ff-only
/// origin/<base>`. Refuses a dirty root and a root not checked out on the base;
/// a non-ff base surfaces git's error verbatim — NEVER a real merge.
#[tauri::command]
pub async fn pull_base_ff(app: AppHandle, id: String) -> Result<(), String> {
    // The fetch talks to the network (up to 120s) — blocking-pool work.
    tauri::async_runtime::spawn_blocking(move || pull_base_ff_blocking(&app, &id))
        .await
        .map_err(|e| format!("pull base failed to run: {e}"))?
}

/// The blocking body of `pull_base_ff`: root lease → resolve the base → the
/// testable core.
fn pull_base_ff_blocking(app: &AppHandle, id: &str) -> Result<(), String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let project = require_project(app)?;
    let project_path = PathBuf::from(&project.path);
    // The pull mutates the SHARED project root, so its guard is the ROOT lease
    // (keyed per project path, shared with merge_task's merge phase and the
    // main-mode commit), not a per-task set: single-flight per PROJECT — two
    // tasks pulling one root refuse each other — and cross-refused against any
    // in-flight merge/commit on that root. The pull takes no per-task lease, so
    // the root lease is its only acquisition (ordering trivially safe).
    let _root_lease = acquire_root_lease(&project_path, "pulling the base")?;
    // GROUNDED base resolution: the task's persisted base (written at PR
    // creation), else the SERVER truth (`gh pr view` baseRefName) for legacy
    // tasks created before the base was persisted. NEVER the root's current
    // branch — that fallback made the strict current==base check below vacuous
    // (whatever branch the root sat on "was" the base) and let the command act
    // on a different branch than the one the confirm dialog named.
    let base = resolve_pull_base(&task, || {
        let number = require_pr_number(&task)?;
        let worktree_dir = worktree::worktree_path(&project_path, id);
        let view_dir = if worktree_dir.exists() {
            worktree_dir
        } else {
            project_path.clone()
        };
        let view = fetch_pr_view_with(&view_dir, GH_BINARY, number, GH_VIEW_TIMEOUT)?;
        Ok(view.base_ref_name.unwrap_or_default())
    })?;
    tracing::info!(target: "nightcore::pr", task_id = %id, base = %base, "fast-forwarding base from origin");
    pull_base_ff_core(&project_path, &base)
}

/// Resolve the base the pull acts on: the task's persisted `base_branch` wins;
/// a legacy task (no persisted base) falls back to `fetch_base_ref` — the
/// gh-reported `baseRefName`, validated through `validate_ref` because it is
/// REMOTE-controlled input headed for a git argv. An empty server answer is a
/// refusal, never a guess. Pure over the injected fetch, so the whole
/// resolution order is unit-testable without a gh spawn.
pub(super) fn resolve_pull_base(
    task: &Task,
    fetch_base_ref: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    if let Some(base) = task.base_branch.clone() {
        return Ok(base);
    }
    let base = fetch_base_ref()?.trim().to_string();
    if base.is_empty() {
        return Err(
            "could not determine the pull request's base branch — GitHub reported none; \
             re-create the PR or set the task's base branch"
                .to_string(),
        );
    }
    validate_ref(&base)?;
    Ok(base)
}

/// The pull core, `AppHandle`-free and unit-tested against a real temp repo
/// pair: validate → refuse a dirty root → refuse a root not on `base` (STRICT
/// current-branch read; a detached HEAD refuses rather than guessing) → bounded
/// fetch → ff-only merge (failure verbatim).
pub(super) fn pull_base_ff_core(project_path: &Path, base: &str) -> Result<(), String> {
    validate_ref(base)?;
    if !worktree::is_worktree_clean(project_path)? {
        return Err(
            "project has uncommitted changes — commit or stash them before pulling the base"
                .to_string(),
        );
    }
    match worktree::current_branch(project_path) {
        Some(current) if current == base => {}
        Some(current) => {
            return Err(format!(
                "the project is checked out on `{current}`, not the base `{base}` — check out the base before pulling"
            ));
        }
        None => {
            return Err(format!(
                "the project is not on a named branch (detached HEAD) — check out `{base}` before pulling"
            ));
        }
    }
    worktree::fetch_base(project_path, base)?;
    worktree::merge_ff_only(project_path, base)
}
