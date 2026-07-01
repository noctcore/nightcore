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

    let task = app.state::<TaskStore>().get(task_id);
    let run_mode = task.as_ref().map(|t| t.run_mode).unwrap_or_default();
    // A branch-picker selection (custom branch and/or base) routes through the
    // branch/base-aware allocate; the default path is `nc/<taskId>` off the current
    // branch.
    let has_custom_selection = task
        .as_ref()
        .map(|t| t.branch.is_some() || t.base_branch.is_some())
        .unwrap_or(false);

    // The dirty-base guard only matters in worktree mode (`main` mode edits the
    // project tree directly, so its cleanliness is irrelevant) — so we don't even
    // run the git cleanliness check for a `main`-mode run: `!is_worktree_mode`
    // short-circuits before `is_worktree_clean`.
    let is_worktree_mode = run_mode.is_worktree();
    let base_is_clean =
        !is_worktree_mode || worktree::is_worktree_clean(&project_path).unwrap_or(true);

    match plan_worktree(is_worktree_mode, base_is_clean, has_custom_selection) {
        WorktreePlan::Root => {
            // `main` mode: run in the project root on the current branch. No worktree,
            // no branch chip, no dirty-base refusal (working in the tree is the point).
            tracing::info!(target: "nightcore", task_id, root = %project_path.display(), "running in project root (main mode)");
            Ok(Some(ResolvedCwd::root(project_path)))
        }
        WorktreePlan::DirtyBaseRefusal => Err(format!(
            "base working tree at {} is dirty; commit or stash before running the loop in worktree mode",
            project_path.display()
        )),
        WorktreePlan::CustomBranch => {
            // `has_custom_selection` was derived from the same task record, so it is
            // present here.
            let t = task.as_ref().expect("custom selection implies a task record");
            let branch = t
                .branch
                .clone()
                .unwrap_or_else(|| worktree::branch_name(task_id));
            let base = t
                .base_branch
                .clone()
                .unwrap_or_else(|| worktree::base_branch(&project_path));
            let dir = worktree::allocate_branch(&project_path, task_id, &branch, &base)?;
            tracing::info!(target: "nightcore", task_id, worktree = %dir.display(), "allocated worktree");
            Ok(Some(ResolvedCwd::worktree(dir)))
        }
        WorktreePlan::DefaultBranch => {
            let dir = worktree::allocate(&project_path, task_id)?;
            tracing::info!(target: "nightcore", task_id, worktree = %dir.display(), "allocated worktree");
            Ok(Some(ResolvedCwd::worktree(dir)))
        }
    }
}

/// The pure launch-cwd decision behind [`resolve_worktree`], factored out of the
/// `AppHandle`/git IO so the `run_mode` × dirty-base × custom-selection branching is
/// unit-testable (the coordinator's `*_inner` pattern — cf. `reconcile_task_inner`).
/// `base_is_clean` is only meaningful in worktree mode; the caller passes `true`
/// (and skips the git check) for `main` mode, where it is ignored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorktreePlan {
    /// `main` mode: run in the project ROOT on the current branch — no dirty-base
    /// refusal, no branch chip.
    Root,
    /// `worktree` mode but the base working tree is dirty — refuse (you can't branch
    /// cleanly off a dirty index).
    DirtyBaseRefusal,
    /// `worktree` mode, clean base, a branch-picker selection → the branch/base-aware
    /// `allocate_branch`.
    CustomBranch,
    /// `worktree` mode, clean base, no selection → the default `nc/<taskId>`
    /// `allocate`.
    DefaultBranch,
}

/// Decide the run-cwd plan from the three inputs `resolve_worktree` resolves off the
/// project/task/git state. Pure so the whole branch matrix is testable without a
/// live project or repo (the AppHandle-bound IO stays in `resolve_worktree`).
fn plan_worktree(
    is_worktree_mode: bool,
    base_is_clean: bool,
    has_custom_selection: bool,
) -> WorktreePlan {
    if !is_worktree_mode {
        return WorktreePlan::Root;
    }
    if !base_is_clean {
        return WorktreePlan::DirtyBaseRefusal;
    }
    if has_custom_selection {
        WorktreePlan::CustomBranch
    } else {
        WorktreePlan::DefaultBranch
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_mode_always_plans_a_root_run() {
        // `main` mode runs in the project root unconditionally: the dirty-base guard
        // is intentionally relaxed and no branch chip is recorded, so neither the
        // base cleanliness nor a custom selection changes the plan.
        for &clean in &[true, false] {
            for &custom in &[true, false] {
                assert_eq!(
                    plan_worktree(false, clean, custom),
                    WorktreePlan::Root,
                    "main mode is always Root (clean={clean}, custom={custom})"
                );
            }
        }
    }

    #[test]
    fn worktree_mode_refuses_a_dirty_base() {
        // You can't branch cleanly off a dirty index, so a dirty base is refused
        // before any allocate — even when a custom branch/base was picked.
        assert_eq!(
            plan_worktree(true, false, false),
            WorktreePlan::DirtyBaseRefusal,
            "a dirty base is refused in worktree mode"
        );
        assert_eq!(
            plan_worktree(true, false, true),
            WorktreePlan::DirtyBaseRefusal,
            "the dirty-base refusal takes precedence over a custom selection"
        );
    }

    #[test]
    fn clean_worktree_routes_custom_vs_default_allocate() {
        // Clean base + a picker selection → the branch/base-aware allocate; clean
        // base + no selection → the default `nc/<taskId>` allocate.
        assert_eq!(
            plan_worktree(true, true, true),
            WorktreePlan::CustomBranch,
            "a custom branch/base routes through allocate_branch"
        );
        assert_eq!(
            plan_worktree(true, true, false),
            WorktreePlan::DefaultBranch,
            "no selection uses the default nc/<taskId> allocate"
        );
    }
}
