//! Commit / merge of verified tasks (M3 §D).
//!
//! Git ops confined to a task's worktree (`commit`) or run as a plain `git merge`
//! into the project base (`merge`, never `--force`). On a clean merge we honor the
//! `cleanupWorktrees` setting; on a conflict the merge is aborted and the task is
//! marked `conflict` for the UI — never forced. Every transition emits `nc:task`.

use tauri::{AppHandle, Emitter, Manager, State};

use crate::gauntlet;
use crate::m2::worktree::{self, MergeOutcome};
use crate::project::{Project, ProjectStore};
use crate::settings::SettingsStore;
use crate::store::TaskStore;
use crate::task::{Task, TaskStatus, TASK_EVENT};

/// The active project, or an error message for a command that needs one.
fn require_project(app: &AppHandle) -> Result<Project, String> {
    app.state::<ProjectStore>()
        .active()
        .ok_or_else(|| "no active project".to_string())
}

/// The commit message for a task: its title, or a fallback when blank.
fn commit_message(task: &Task) -> String {
    let title = task.title.trim();
    if title.is_empty() {
        format!("nightcore: task {}", task.id)
    } else {
        title.to_string()
    }
}

/// Commit a task's worktree: `git add -A` + commit with a message from the task
/// title. Confined to the task's worktree. Surfaces "nothing to commit" as an
/// error so the UI can show it; marks the task committed on success.
#[tauri::command]
pub fn commit_task(app: AppHandle, store: State<'_, TaskStore>, id: String) -> Result<(), String> {
    let task = store.get(&id).ok_or_else(|| format!("no task with id {id}"))?;
    let project = require_project(&app)?;
    let message = commit_message(&task);

    let committed = worktree::commit(&std::path::PathBuf::from(&project.path), &id, &message)?;
    if !committed {
        return Err("nothing to commit".to_string());
    }
    let updated = store.mutate(&id, |t| {
        t.committed = true;
        t.conflict = false;
    })?;
    let _ = app.emit(TASK_EVENT, &updated);
    Ok(())
}

/// Merge a task's `nc/<taskId>` branch into the project base branch. On success,
/// honor `cleanupWorktrees` (remove the worktree + delete the branch) and mark the
/// task merged; on conflict, mark `conflict` and surface an error (never forced).
#[tauri::command]
pub fn merge_task(app: AppHandle, store: State<'_, TaskStore>, id: String) -> Result<(), String> {
    let task = store.get(&id).ok_or_else(|| format!("no task with id {id}"))?;
    let project = require_project(&app)?;
    let project_path = std::path::PathBuf::from(&project.path);

    // M4 §D: merge — the one irreversible action — requires an earned PASS and a
    // passing local gauntlet. No force, ever. A `!verified` task routes through the
    // Verifying/approval flow instead.
    if !task.verified {
        return Err(
            "task is not verified — a reviewer must pass it (or accept the review) before merging"
                .to_string(),
        );
    }
    let worktree_dir = worktree::worktree_path(&project_path, &id);
    if worktree_dir.exists() {
        let result = gauntlet::run(&worktree_dir);
        if !result.passed {
            let failed = result.failed_step.clone().unwrap_or_default();
            return Err(format!(
                "readiness gauntlet failed at `{failed}` — fix the checks before merging"
            ));
        }
    }
    let base = worktree::base_branch(&project_path);

    match worktree::merge(&project_path, &id, &base)? {
        MergeOutcome::Merged => {
            let cleanup = app.state::<SettingsStore>().get().cleanup_worktrees;
            if cleanup {
                let _ = worktree::remove(&project_path, &id);
                let _ = worktree::delete_branch(&project_path, &id);
            }
            let updated = store.mutate(&id, |t| {
                t.merged = true;
                t.conflict = false;
            })?;
            let _ = app.emit(TASK_EVENT, &updated);
            Ok(())
        }
        MergeOutcome::Conflict => {
            let updated = store.mutate(&id, |t| {
                t.conflict = true;
                t.error = Some(format!(
                    "merge conflict integrating {} into {base}",
                    t.branch.clone().unwrap_or_default()
                ));
            })?;
            let _ = app.emit(TASK_EVENT, &updated);
            Err(format!("merge conflict integrating into {base}"))
        }
    }
}

// --- Verification approval (M4 §D) ------------------------------------------
//
// These resolve a verification `WaitingApproval` (a task the gate parked after a
// FAIL / exhausted auto-fix / inconclusive review). Distinct from the *plan*
// approval in `plan_approval.rs`: a verification-parked task has NO live session,
// so those permission-resolving commands don't apply here.

/// Accept the review on the user's authority (override the reviewer): mark the
/// task `verified` and `Done`. The worktree is retained for commit/merge.
#[tauri::command]
pub fn accept_review(app: AppHandle, store: State<'_, TaskStore>, id: String) -> Result<(), String> {
    store.get(&id).ok_or_else(|| format!("no task with id {id}"))?;
    let updated = store.mutate(&id, |t| {
        t.verified = true;
        t.status = TaskStatus::Done;
        t.error = None;
    })?;
    let _ = app.emit(TASK_EVENT, &updated);
    Ok(())
}

/// Reject the review: send the task back to `Backlog` (not verified), keeping
/// `task.review` for context so the user sees why it was rejected.
#[tauri::command]
pub fn reject_review(app: AppHandle, store: State<'_, TaskStore>, id: String) -> Result<(), String> {
    store.get(&id).ok_or_else(|| format!("no task with id {id}"))?;
    let updated = store.mutate(&id, |t| {
        t.verified = false;
        t.status = TaskStatus::Backlog;
    })?;
    let _ = app.emit(TASK_EVENT, &updated);
    Ok(())
}

/// Re-run verification against the current worktree without rebuilding (M4 §D):
/// move the task back to `Verifying`, lease a slot, and dispatch a fresh reviewer
/// session. Refuses when there is no worktree to diff.
#[tauri::command]
pub async fn rerun_verification(
    app: AppHandle,
    store: State<'_, TaskStore>,
    orch: State<'_, crate::m2::coordinator::Orchestrator>,
    id: String,
) -> Result<(), String> {
    store.get(&id).ok_or_else(|| format!("no task with id {id}"))?;
    let project = require_project(&app)?;
    let worktree_dir = worktree::worktree_path(&std::path::PathBuf::from(&project.path), &id);
    if !worktree_dir.exists() {
        return Err("no worktree to verify — re-run the task instead".to_string());
    }

    if !orch.slots.try_lease(&id) {
        return Err("no free slot (max concurrency reached)".to_string());
    }
    if let Err(e) = crate::sidecar::ensure_reader(&app).await {
        orch.slots.release(&id);
        return Err(e);
    }
    if let Ok(updated) = store.mutate(&id, |t| {
        t.status = TaskStatus::Verifying;
        t.verified = false;
        t.error = None;
    }) {
        let _ = app.emit(TASK_EVENT, &updated);
    }
    if let Err(e) = crate::sidecar::dispatch_reviewer_for(&app, &id, &worktree_dir).await {
        orch.slots.release(&id);
        if let Ok(updated) = store.mutate(&id, |t| {
            t.status = TaskStatus::WaitingApproval;
            t.error = Some(format!("could not start reviewer: {e}"));
        }) {
            let _ = app.emit(TASK_EVENT, &updated);
        }
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_message_uses_title_or_falls_back() {
        let mut task = Task::new("Add login form".into(), String::new());
        assert_eq!(commit_message(&task), "Add login form");

        task.title = "   ".into();
        assert!(commit_message(&task).contains(&task.id));
    }
}
