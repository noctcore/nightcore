//! The `merge_task` path: integrate a verified task's `nc/<taskId>` branch into
//! the project base with a plain `git merge` (never `--force`). Gated behind the
//! readiness + structure-lock gauntlets; on a clean merge it honors
//! `cleanupWorktrees`, on a conflict it aborts and marks the task `conflict`.

use tauri::{AppHandle, Emitter, Manager};

use super::commit::require_project;
use super::lease::{acquire_root_lease, lease_held, merge_in_flight, TaskLease};
use crate::gauntlet;
use crate::gauntlet_project;
use crate::settings::SettingsStore;
use crate::store::TaskStore;
use crate::task::{Task, TASK_EVENT};
use crate::worktree::{self, MergeOutcome};

/// Whether a task is mergeable at all (M4.6 §A.3): only worktree-mode tasks have a
/// `nc/<taskId>` branch to integrate. A main-mode task's edits already live on the
/// project's current branch, so `merge_task` refuses it with this guard. Pure, so
/// the refusal is unit-testable without a live `AppHandle`.
pub(super) fn refuse_main_mode_merge(task: &Task) -> Result<(), String> {
    if task.run_mode.is_worktree() {
        return Ok(());
    }
    Err(
        "this task runs on main — its changes are already on the project branch; \
         there is no worktree branch to merge (commit them instead)"
            .to_string(),
    )
}

/// Refuse a merge while a PR creation holds the task — the mirror of
/// `pr::refuse_while_sibling_in_flight`. A completing merge (with
/// `cleanup_worktrees` on) deletes the worktree + branch out from under an
/// in-flight push/`gh pr create`. Checked AFTER the merge lease is acquired, so
/// the two directions can't slip past each other: whichever action leases
/// second sees the other's lease.
pub(super) fn refuse_while_pr_in_flight(id: &str) -> Result<(), String> {
    if lease_held(crate::workflow::pr::pr_in_flight(), id) {
        return Err(
            "a PR is being created for this task — wait for it to finish before merging"
                .to_string(),
        );
    }
    Ok(())
}

/// Merge a task's `nc/<taskId>` branch into the project base branch. On success,
/// honor `cleanupWorktrees` (remove the worktree + delete the branch) and mark the
/// task merged; on conflict, mark `conflict` and surface an error (never forced).
#[tauri::command]
pub async fn merge_task(app: AppHandle, id: String) -> Result<(), String> {
    // Like commit_task: the body runs the readiness + structure-lock gauntlets and a
    // `git merge` — seconds of blocking work that a synchronous command would run on
    // the main thread, freezing the WKWebView (so the "Merging…" state can't paint).
    // Offload to the blocking pool and await.
    tauri::async_runtime::spawn_blocking(move || merge_task_blocking(&app, &id))
        .await
        .map_err(|e| format!("merge task failed to run: {e}"))?
}

/// The blocking body of `merge_task`, run off the UI thread via `spawn_blocking`
/// (see `commit_task_blocking` for the state-reacquisition rationale).
fn merge_task_blocking(app: &AppHandle, id: &str) -> Result<(), String> {
    // Single-flight per task: merge is the one irreversible action — never race two.
    let _lease = TaskLease::acquire(merge_in_flight(), id)
        .ok_or_else(|| "a merge for this task is already in progress".to_string())?;
    // Cross-action serialization: never merge under an in-flight PR creation —
    // the merge's cleanup would delete the worktree/branch mid push/create.
    refuse_while_pr_in_flight(id)?;
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    // Fix-arc cross-guard: never merge while a PR-fix session (or its auto-
    // commit) works this task's checkout — the merge's cleanup would delete the
    // worktree out from under the live session. The `pr_in_flight` refusal above
    // only covers the fix's SETUP/PUSH windows; the registry's running entry
    // covers the session's whole runtime.
    let fix_registry = app
        .try_state::<crate::workflow::pr_fix::PrFixRegistry>()
        .ok_or_else(|| "pr-fix registry unavailable".to_string())?;
    crate::workflow::pr_fix::refuse_while_fix_running(
        &fix_registry,
        task.pr_number,
        id,
        "merging",
    )?;
    let project = require_project(app)?;
    let project_path = std::path::PathBuf::from(&project.path);

    // M4.6 §A.3: a main-mode task has no `nc/<taskId>` branch to merge — its edits
    // already live on the project's current branch. Refuse with a clear message
    // (commit_task may still commit in place); only worktree-mode tasks merge.
    refuse_main_mode_merge(&task)?;

    // M4 §D: merge — the one irreversible action — requires an earned PASS and a
    // passing local gauntlet. No force, ever. A `!verified` task routes through the
    // Verifying/approval flow instead.
    if !task.verified {
        return Err(
            "task is not verified — a reviewer must pass it (or accept the review) before merging"
                .to_string(),
        );
    }
    let worktree_dir = worktree::worktree_path(&project_path, id);
    if worktree_dir.exists() {
        let result = gauntlet::run(&worktree_dir);
        if !result.passed {
            let failed = result.failed_step.clone().unwrap_or_default();
            return Err(format!(
                "readiness gauntlet failed at `{failed}` — fix the checks before merging"
            ));
        }
        // Structure-Lock Gauntlet (feature #3): re-run the TARGET project's own
        // generated harness checks at merge too, so a stale worktree can't merge
        // past the lock the verification gate already enforced. Reject on failure —
        // never force. Absent `.nightcore/harness.json` ⇒ no checks ⇒ pass.
        let lock = gauntlet_project::run(&worktree_dir);
        if !lock.passed {
            let failed = lock.failed_check.clone().unwrap_or_default();
            return Err(format!(
                "structure-lock gauntlet failed at `{failed}` — fix the harness checks before merging"
            ));
        }
    }
    // Base + branch honor the create dialog's branch picker, defaulting to the
    // project's current branch and `nc/<taskId>` respectively.
    let base = task
        .base_branch
        .clone()
        .unwrap_or_else(|| worktree::base_branch(&project_path));
    let branch = task
        .branch
        .clone()
        .unwrap_or_else(|| worktree::branch_name(id));
    tracing::info!(target: "nightcore", task_id = %id, branch = %branch, base = %base, "merging task branch into base");

    // The real merge mutates the SHARED project root — serialize it against the
    // other root mutators (pull-base ff, main-mode commit) via the root lease.
    // ORDERING: task lease first (top of fn), root lease second. Acquired after
    // the gauntlets (which run inside the worktree, not the root) so a long
    // gauntlet never holds the root hostage.
    let _root_lease = acquire_root_lease(&project_path, "merging")?;

    match worktree::merge_branch(&project_path, &branch, &base)? {
        MergeOutcome::Merged => {
            let cleanup = app
                .state::<SettingsStore>()
                .with_settings(|s| s.cleanup_worktrees);
            if cleanup {
                let _ = worktree::remove(&project_path, id);
                let _ = worktree::delete_branch_named(&project_path, &branch);
            }
            tracing::info!(target: "nightcore", task_id = %id, base = %base, cleaned_up = cleanup, "merge succeeded");
            let updated = store.mutate(id, |t| {
                t.merged = true;
                t.conflict = false;
            })?;
            let _ = app.emit(TASK_EVENT, &updated);
            Ok(())
        }
        MergeOutcome::Conflict => {
            tracing::warn!(target: "nightcore", task_id = %id, base = %base, "merge hit a conflict; left clean (not forced)");
            let updated = store.mutate(id, |t| {
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
