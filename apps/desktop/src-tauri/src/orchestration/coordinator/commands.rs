//! The coordinator's `#[tauri::command]` handlers: thin wrappers over the
//! `auto_loop` lifecycle surface (arm/disarm/resume/resize) plus the two
//! worktree readers (`list_worktrees`/`refresh_worktrees`). Kept in their own
//! sibling so `coordinator/mod.rs` stays a pure manifest; the `commands::*` glob
//! re-export there is what lets `generate_handler!` reach the macro siblings.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::project::ProjectStore;
use crate::worktree;

use super::{
    reconcile_stale_worktree_state, reconcile_worktrees, resume, set_max_concurrency, start, stop,
};

/// Arm the coordinator: start pulling eligible tasks off the board and running
/// them up to the concurrency cap, in isolated worktrees, respecting deps.
#[tauri::command]
pub fn start_auto_loop(app: AppHandle) -> Result<(), String> {
    start(&app)
}

/// Disarm the coordinator and abort every in-flight run.
#[tauri::command]
pub fn stop_auto_loop(app: AppHandle) -> Result<(), String> {
    stop(&app);
    Ok(())
}

/// Clear a circuit-breaker pause and resume the loop.
#[tauri::command]
pub fn resume_auto_loop(app: AppHandle) -> Result<(), String> {
    resume(&app)
}

/// Resize the parallel-run pool (1..=N). Persisted concurrency lives in settings;
/// this applies it to the live pool.
#[tauri::command]
pub fn set_max_concurrency_cmd(app: AppHandle, n: usize) -> Result<(), String> {
    set_max_concurrency(&app, n);
    Ok(())
}

/// List the live Nightcore worktrees for the active project (M4.6 §C): each
/// `nc/<taskId>` worktree on disk with its `{ branch, path, taskIds, dirty,
/// aheadOfBase }`, driving the web switcher's monitor indicators. Read-only and
/// tolerant of a missing/locked worktree (it degrades to safe defaults). The
/// status read spawns N× git subprocesses (dirty + ahead-of-base per worktree),
/// so it runs on the blocking pool like the sibling `refresh_worktrees` —
/// never on the UI thread. Returns an empty list when there is no active project.
#[tauri::command]
pub async fn list_worktrees(app: AppHandle) -> Result<Vec<worktree::WorktreeStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(project) = app.state::<ProjectStore>().active() else {
            return Ok(Vec::new());
        };
        Ok(worktree::list_worktree_statuses(&PathBuf::from(
            &project.path,
        )))
    })
    .await
    .map_err(|e| format!("list worktrees failed to run: {e}"))?
}

/// Explicitly reconcile + re-read the active project's worktrees (M4.6 §C, the
/// board/Worktrees "Refresh" control). Recovers from any stale state WITHOUT an app
/// restart: prunes orphaned worktrees (no live task) + `git worktree prune`, clears
/// ghost branch pointers (a task chip with no worktree dir left), reclaims
/// fully-merged clean worktrees (a PR merged out-of-band after `finalize` refused
/// cleanup), then returns the fresh statuses. Every removal is guarded by the slot
/// lease (a running task is never touched) and is abort-not-force. Does the git +
/// store work off the UI thread; emits `nc:task` per reconciled task so the board
/// re-renders. Returns an empty list when there is no active project.
#[tauri::command]
pub async fn refresh_worktrees(app: AppHandle) -> Result<Vec<worktree::WorktreeStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Prune orphaned dirs (task left the store) + git admin drift, then
        // reconcile stale pointers and reclaim merged leftovers (the explicit
        // refresh is the one place we prune fully-merged worktrees).
        reconcile_worktrees(&app);
        reconcile_stale_worktree_state(&app, true);
        let Some(project) = app.state::<ProjectStore>().active() else {
            return Ok(Vec::new());
        };
        Ok(worktree::list_worktree_statuses(&PathBuf::from(
            &project.path,
        )))
    })
    .await
    .map_err(|e| format!("refresh worktrees failed to run: {e}"))?
}
