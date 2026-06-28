//! Run-cwd resolution: pick the working directory for a run, branching on the
//! task's `run_mode` (`main` → project root, `worktree` → an isolated `nc/<taskId>`
//! worktree off a clean base).

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::worktree;
use crate::project::ProjectStore;
use crate::store::TaskStore;

/// Resolve the run cwd for a task, branching on its `run_mode` (M4.6 §B). Returns
/// `Ok(None)` when there is no active project (run in the workspace root, M1
/// behavior). For `main` mode the cwd is the project ROOT (edits land on the
/// current branch directly); the dirty-base refusal is intentionally relaxed —
/// the user chose to work in the project tree. For `worktree` mode a `nc/<taskId>`
/// worktree is allocated off a CLEAN base (you can't branch cleanly off a dirty
/// index, so that guard stays here). The returned dir is paired with whether it is
/// a worktree so the caller only records a branch chip in worktree mode.
pub(crate) fn resolve_worktree(
    app: &AppHandle,
    task_id: &str,
) -> Result<Option<ResolvedCwd>, String> {
    let projects = app.state::<ProjectStore>();
    let Some(project) = projects.active() else {
        return Ok(None);
    };
    let project_path = PathBuf::from(&project.path);

    let run_mode = app
        .state::<TaskStore>()
        .get(task_id)
        .map(|t| t.run_mode)
        .unwrap_or_default();

    if !run_mode.is_worktree() {
        // `main` mode: run in the project root on the current branch. No worktree,
        // no branch chip, no dirty-base refusal (working in the tree is the point).
        tracing::info!(target: "nightcore", task_id, root = %project_path.display(), "running in project root (main mode)");
        return Ok(Some(ResolvedCwd::root(project_path)));
    }

    if !worktree::is_worktree_clean(&project_path).unwrap_or(true) {
        return Err(format!(
            "base working tree at {} is dirty; commit or stash before running the loop in worktree mode",
            project_path.display()
        ));
    }
    let dir = worktree::allocate(&project_path, task_id)?;
    tracing::info!(target: "nightcore", task_id, worktree = %dir.display(), "allocated worktree");
    Ok(Some(ResolvedCwd::worktree(dir)))
}

/// A resolved run cwd plus whether it is an isolated worktree. `is_worktree`
/// distinguishes a `main`-mode project-root run (no branch chip, no auto-merge)
/// from a `worktree`-mode run (`nc/<taskId>` branch).
pub struct ResolvedCwd {
    pub path: PathBuf,
    pub is_worktree: bool,
}

impl ResolvedCwd {
    fn root(path: PathBuf) -> Self {
        Self {
            path,
            is_worktree: false,
        }
    }
    fn worktree(path: PathBuf) -> Self {
        Self {
            path,
            is_worktree: true,
        }
    }
}
