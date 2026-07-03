//! Read-only worktree queries (branch list, merge preview, diff) + the discard
//! action — the command surface for the branch picker and the worktree manager.
//!
//! These legitimately depend on both persistence ([`crate::store`]) and, for the
//! discard guard, orchestration ([`crate::orchestration`]), so they live in the
//! command layer (see `commands/mod.rs`). Git itself runs entirely in
//! [`crate::worktree`]; this module only resolves project/task → calls those
//! primitives off the UI thread.

use tauri::{AppHandle, Emitter, Manager};

use crate::project::ProjectStore;
use crate::store::TaskStore;
use crate::task::{Task, TASK_EVENT};
use crate::worktree::{self, BranchInfo, MergePreview, WorktreeDiff};

/// The active project's path, or an error for a command that needs one.
fn active_project_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.state::<ProjectStore>()
        .active()
        .map(|p| std::path::PathBuf::from(&p.path))
        .ok_or_else(|| "no active project".to_string())
}

/// Resolve a task's worktree branch: its recorded branch, else the default `nc/<id>`.
fn task_branch(task: &Task) -> String {
    task.branch
        .clone()
        .unwrap_or_else(|| worktree::branch_name(&task.id))
}

/// The active project's branches (local + remote-tracking) for the branch picker.
/// Empty when there is no active project (the picker degrades to free-form entry).
#[tauri::command]
pub fn list_branches(app: AppHandle) -> Result<Vec<BranchInfo>, String> {
    let Some(project) = app.state::<ProjectStore>().active() else {
        return Ok(Vec::new());
    };
    Ok(worktree::list_branches(&std::path::PathBuf::from(
        &project.path,
    )))
}

/// Preview merging a task's worktree branch into `base` (defaults to the project's
/// base branch) — read-only. The git reads run off the UI thread.
#[tauri::command]
pub async fn merge_preview(
    app: AppHandle,
    id: String,
    base: Option<String>,
) -> Result<MergePreview, String> {
    tauri::async_runtime::spawn_blocking(move || merge_preview_blocking(&app, &id, base))
        .await
        .map_err(|e| format!("merge preview failed to run: {e}"))?
}

fn merge_preview_blocking(
    app: &AppHandle,
    id: &str,
    base: Option<String>,
) -> Result<MergePreview, String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let project = active_project_path(app)?;
    let branch = task_branch(&task);
    // Preview against the task's chosen base (matching what `merge_task` will target),
    // an explicit override, else the project's current branch — validated identically to
    // `merge_branch` so a bogus/option-shaped base fails loudly here instead of yielding a
    // silently degraded preview that the actual (validating) merge would then reject.
    let base = resolve_preview_base(base, task.base_branch.as_deref(), &project)?;
    // The resolved branch is validated too, mirroring `merge_branch`'s two-ref check.
    worktree::validate_ref(&branch)?;
    Ok(worktree::merge_preview(&project, &branch, &base))
}

/// Resolve the preview base (explicit override → task's stored base → project's current
/// branch) and reject an illegal/option-shaped ref before it reaches git — mirroring
/// [`merge_branch`], so a read-only preview and the merge it previews agree on what is a
/// legal base.
fn resolve_preview_base(
    explicit: Option<String>,
    task_base: Option<&str>,
    project: &std::path::Path,
) -> Result<String, String> {
    let base = explicit
        .or_else(|| task_base.map(str::to_string))
        .unwrap_or_else(|| worktree::base_branch(project));
    worktree::validate_ref(&base)?;
    Ok(base)
}

/// The changed files in a task's worktree vs base (committed + uncommitted + untracked).
#[tauri::command]
pub async fn worktree_diff(app: AppHandle, id: String) -> Result<WorktreeDiff, String> {
    tauri::async_runtime::spawn_blocking(move || worktree_diff_blocking(&app, &id))
        .await
        .map_err(|e| format!("worktree diff failed to run: {e}"))?
}

fn worktree_diff_blocking(app: &AppHandle, id: &str) -> Result<WorktreeDiff, String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let project = active_project_path(app)?;
    let dir = worktree::worktree_path(&project, id);
    if !dir.exists() {
        return Err(format!("no worktree for task {id} — run it first"));
    }
    // Diff against the task's chosen base (matching the merge target), else the
    // project's current branch.
    let base = task
        .base_branch
        .clone()
        .unwrap_or_else(|| worktree::base_branch(&project));
    Ok(worktree::worktree_diff(&dir, &base))
}

/// Discard a task's worktree and its branch — a safe cleanup distinct from deleting
/// the task. Removes the worktree dir (robustly), then deletes its branch (guarded
/// so the base branch can never be deleted), and clears any conflict/error flag.
/// Refuses while the task is actively running. Idempotent + best-effort; emits
/// `nc:task`.
#[tauri::command]
pub async fn discard_worktree(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || discard_worktree_blocking(&app, &id))
        .await
        .map_err(|e| format!("discard worktree failed to run: {e}"))?
}

fn discard_worktree_blocking(app: &AppHandle, id: &str) -> Result<(), String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    // Refuse to pull a worktree out from under a live run (authoritative: the slot
    // lease). A finished/failed/idle task is safe to discard.
    if let Some(orch) = app.try_state::<crate::orchestration::coordinator::Orchestrator>() {
        if orch.slots.is_leased(id) {
            return Err(
                "this task is still running — stop it before discarding its worktree".to_string(),
            );
        }
    }
    let project = active_project_path(app)?;
    // Remove the worktree first (frees its checked-out branch), then delete the
    // branch — the load-bearing order (deleting a checked-out branch fails).
    worktree::remove(&project, id)?;
    let _ = worktree::delete_branch_named(&project, &task_branch(&task));
    let updated = store.mutate(id, |t| {
        t.conflict = false;
        t.error = None;
    })?;
    let _ = app.emit(TASK_EVENT, &updated);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn preview_base_rejects_option_shaped_explicit_base() {
        // An explicit option-shaped base must be rejected before it reaches git —
        // identical to `merge_branch`'s `validate_ref`, so the preview and the merge it
        // previews never disagree on what is a legal base. (The explicit override wins,
        // so the project path is never consulted.)
        for bad in ["--all", "-D", "--orphan", "-"] {
            let err = resolve_preview_base(Some(bad.to_string()), None, Path::new("/nonexistent"))
                .unwrap_err();
            assert!(
                err.contains("invalid branch/base name"),
                "explicit base {bad:?} must be rejected loudly, got: {err}"
            );
        }
    }

    #[test]
    fn preview_base_accepts_a_legal_explicit_base() {
        let base = resolve_preview_base(Some("main".to_string()), None, Path::new("/nonexistent"))
            .expect("a legal explicit base must resolve");
        assert_eq!(base, "main");
    }

    #[test]
    fn preview_base_validates_a_bogus_task_base() {
        // Falling back to the task's stored base must also be validated (an option-shaped
        // stored base must not slip through into a degraded preview).
        let err =
            resolve_preview_base(None, Some("--force"), Path::new("/nonexistent")).unwrap_err();
        assert!(
            err.contains("invalid branch/base name"),
            "a bogus task base must be rejected, got: {err}"
        );
    }
}
