//! Task-state marking, startup worktree pruning, and boot/crash reconciliation.
//!
//! The marking helpers ([`mark_task_in_progress`], [`fail_task`]) are shared by the
//! launch sequence. The reconcilers ([`reconcile_worktrees`], [`reconcile_tasks`]) run
//! synchronously in the Tauri setup hook to prune orphaned worktrees and recover
//! tasks a crash stranded mid-run. A finished task's worktree is NOT torn down here —
//! it is kept for review and removed only on merge (`workflow::merge`) or discard.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};

use crate::project::ProjectStore;
use crate::store::TaskStore;
use crate::task::{TaskStatus, TASK_EVENT};
use crate::worktree;

/// Mark a task `InProgress` for a fresh run: clear the prior summary/error and the
/// verification verdict (M4 §B), and record the run's `branch` chip (worktree mode
/// only; main mode clears any stale branch). Persists and emits `nc:task` on
/// success. Shared by the auto-loop `launch` and the manual `run_task` so the two
/// dispatch paths mark a run identically.
pub(crate) fn mark_task_in_progress(
    app: &AppHandle,
    task_id: &str,
    branch: Option<String>,
) -> Result<crate::task::Task, String> {
    let updated = app.state::<TaskStore>().mutate(task_id, |t| {
        t.status = TaskStatus::InProgress;
        t.summary = None;
        t.error = None;
        t.verified = false;
        t.review = None;
        t.fix_attempts = 0;
        t.branch = branch.clone();
    })?;
    let _ = app.emit(TASK_EVENT, &updated);
    Ok(updated)
}

/// Mark a task failed with `message`, persist, and emit `nc:task`. Shared by the
/// auto-loop `launch` and the manual `run_task` setup paths so a launch failure is
/// recorded identically; the breaker is fed by the auto-loop caller only (a manual
/// run must not trip the loop's circuit breaker).
pub(crate) fn fail_task(app: &AppHandle, task_id: &str, message: &str) {
    let store = app.state::<TaskStore>();
    tracing::error!(target: "nightcore", task_id, error = message, "task launch failed");
    if let Ok(updated) = store.mutate(task_id, |t| {
        t.status = TaskStatus::Failed;
        t.error = Some(message.to_string());
    }) {
        let _ = app.emit(TASK_EVENT, &updated);
        // A launch failure is a genuine terminal Failed that never reaches
        // `finish_run`; notify the same way (M3 §C, gated on `notify_on_complete`).
        crate::sidecar::notify_task_complete(app, task_id, false);
    }
}

/// Startup reconciliation: prune orphaned worktrees (no live task) for the active
/// project. Safe no-op when there's no active project.
pub fn reconcile_worktrees(app: &AppHandle) {
    let projects = app.state::<ProjectStore>();
    let Some(project) = projects.active() else {
        return;
    };
    let store = app.state::<TaskStore>();
    let live: Vec<String> = store.list().into_iter().map(|t| t.id.clone()).collect();
    let pruned = worktree::reconcile(&PathBuf::from(&project.path), &live);
    if !pruned.is_empty() {
        tracing::info!(target: "nightcore", pruned = pruned.len(), "worktree reconcile pruned orphans");
    }
}

/// How a crash-stranded task was recovered at boot, returned by the pure inner so
/// callers (and tests) can assert and log per-task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// An `InProgress`/`Verifying` task reset to `Ready` for a fresh run.
    Requeued,
}

/// Boot reconciliation (M4.5 §A): recover tasks stranded mid-run by a crash.
///
/// In-flight orchestrator state (slot leases, the session↔task map, the breaker)
/// is all in-memory and starts empty after a restart, and the auto-loop only
/// re-picks `Backlog`/`Ready` — so a task persisted as `InProgress`/`Verifying`
/// when the process died is stranded forever (its sidecar, which would emit the
/// terminal event, is dead too). Reset such tasks to `Ready` so the loop re-picks
/// them, clearing the stale `session_id` (it points at a dead session that
/// `cancel_task`/`respond_permission` would trust) and the verification verdict a
/// fresh run would clear, and append a note to `task.error`.
///
/// **`Verifying` path — reset, not re-dispatch.** The contract prefers
/// re-dispatching the reviewer over the retained worktree, but boot reconciliation
/// runs synchronously in the Tauri setup hook and the sidecar is spawned lazily
/// (first `run_task`/tick), so there is no live session to dispatch into here.
/// Per the contract's fallback, `Verifying` is reset to `Ready` exactly like
/// `InProgress`; the next run re-builds and re-reviews from scratch (RESUME is P1).
pub fn reconcile_tasks(app: &AppHandle) {
    let store = app.state::<TaskStore>();
    let mut requeued = 0usize;
    for task in store.list() {
        let Some((status, _)) = reconcile_task_inner(&task.status) else {
            continue;
        };
        match store.mutate(&task.id, apply_recovery) {
            Ok(updated) => {
                requeued += 1;
                tracing::info!(
                    target: "nightcore",
                    task_id = %updated.id,
                    from = ?status,
                    "requeued crash-stranded task to Ready"
                );
                let _ = app.emit(TASK_EVENT, &updated);
            }
            Err(e) => {
                tracing::warn!(target: "nightcore", task_id = %task.id, error = %e, "failed to requeue stranded task");
            }
        }
    }
    if requeued > 0 {
        tracing::info!(target: "nightcore", requeued, "boot reconciliation requeued stranded tasks");
    } else {
        tracing::debug!(target: "nightcore", "boot reconciliation found no stranded tasks");
    }
}

/// The pure decision behind [`reconcile_tasks`]: given a task's persisted status,
/// decide whether (and how) it must be recovered. `InProgress`/`Verifying` →
/// `Some((status, Recovery::Requeued))`; every other status (terminal, launchable,
/// or awaiting approval) → `None` (left untouched). No `AppHandle`, so it is
/// unit-testable like `move_task_inner`.
fn reconcile_task_inner(status: &TaskStatus) -> Option<(TaskStatus, Recovery)> {
    match status {
        TaskStatus::InProgress | TaskStatus::Verifying => Some((*status, Recovery::Requeued)),
        _ => None,
    }
}

/// Apply the requeue recovery to a task in place: reset to `Ready`, clear the stale
/// session id + the verification fields a fresh run would clear, and append the
/// interrupted note to `error`. Pure; shared by `reconcile_tasks` and its tests.
fn apply_recovery(t: &mut crate::task::Task) {
    t.status = TaskStatus::Ready;
    t.session_id = None;
    t.verified = false;
    t.review = None;
    t.fix_attempts = 0;
    t.error = Some(match t.error.take() {
        Some(prev) if !prev.is_empty() => format!("{prev}\nInterrupted by restart — requeued."),
        _ => "Interrupted by restart — requeued.".to_string(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::Task;

    #[test]
    fn reconcile_inner_requeues_in_flight_and_leaves_others_untouched() {
        // In-flight statuses are recovered…
        for status in [TaskStatus::InProgress, TaskStatus::Verifying] {
            assert_eq!(
                reconcile_task_inner(&status),
                Some((status, Recovery::Requeued)),
                "{status:?} must be requeued"
            );
        }
        // …everything terminal / launchable / awaiting-approval is left alone.
        for status in [
            TaskStatus::Backlog,
            TaskStatus::Ready,
            TaskStatus::WaitingApproval,
            TaskStatus::Done,
            TaskStatus::Failed,
        ] {
            assert!(
                reconcile_task_inner(&status).is_none(),
                "{status:?} must be left untouched"
            );
        }
    }

    #[test]
    fn apply_recovery_resets_status_session_and_verify_fields() {
        let mut t = Task::new("t".into(), String::new());
        t.status = TaskStatus::InProgress;
        t.session_id = Some(42);
        t.verified = true;
        t.review = Some("prior review".into());
        t.fix_attempts = 2;

        apply_recovery(&mut t);

        assert_eq!(
            t.status,
            TaskStatus::Ready,
            "reset to Ready so the loop re-picks it"
        );
        assert!(t.session_id.is_none(), "stale dead-session id is cleared");
        assert!(
            !t.verified,
            "verification verdict is cleared for a fresh run"
        );
        assert!(t.review.is_none());
        assert_eq!(t.fix_attempts, 0);
        assert_eq!(
            t.error.as_deref(),
            Some("Interrupted by restart — requeued."),
            "the interrupted note is appended"
        );
    }

    #[test]
    fn apply_recovery_appends_note_to_existing_error() {
        let mut t = Task::new("t".into(), String::new());
        t.status = TaskStatus::Verifying;
        t.error = Some("earlier failure detail".into());

        apply_recovery(&mut t);

        assert_eq!(
            t.error.as_deref(),
            Some("earlier failure detail\nInterrupted by restart — requeued."),
            "the note is appended, not clobbering prior context"
        );
    }

    #[test]
    fn reconcile_over_a_store_requeues_only_stranded_tasks() {
        // Seed a store the way `reconcile_tasks` reads it (the pure decision +
        // apply_recovery + store.mutate, without a live AppHandle).
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let store = TaskStore::load_from(tmp.path().join("tasks"));

        let seed = |status: TaskStatus| -> String {
            let mut t = Task::new("seed".into(), String::new());
            t.status = status;
            let id = t.id.clone();
            store.upsert(&t).expect("seed");
            id
        };
        let in_progress = seed(TaskStatus::InProgress);
        let verifying = seed(TaskStatus::Verifying);
        let done = seed(TaskStatus::Done);
        let backlog = seed(TaskStatus::Backlog);

        // Mirror `reconcile_tasks`'s body without an AppHandle.
        for task in store.list() {
            if reconcile_task_inner(&task.status).is_some() {
                store.mutate(&task.id, apply_recovery).expect("requeue");
            }
        }

        assert_eq!(store.get(&in_progress).unwrap().status, TaskStatus::Ready);
        assert_eq!(store.get(&verifying).unwrap().status, TaskStatus::Ready);
        assert_eq!(
            store.get(&done).unwrap().status,
            TaskStatus::Done,
            "terminal untouched"
        );
        assert_eq!(
            store.get(&backlog).unwrap().status,
            TaskStatus::Backlog,
            "backlog untouched"
        );
    }
}
