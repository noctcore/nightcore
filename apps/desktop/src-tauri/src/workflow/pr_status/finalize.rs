//! [`finalize_merged_pr`] — close the loop on a PR merged ON GitHub: verify
//! `state == MERGED` server-side (never trust the caller), refuse if unpushed
//! local commits would be destroyed, then mirror the local merge's post-merge
//! tail (cleanup + `merged` flag + `nc:task`).

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager};

use super::view::{fetch_pr_view_with, require_pr_number, GH_VIEW_TIMEOUT};
use crate::git::gh::GH_BINARY;
use crate::settings::SettingsStore;
use crate::store::TaskStore;
use crate::task::{Task, TaskStatus, TASK_EVENT};
use crate::workflow::merge::{
    commit_in_flight, lease_held, merge_in_flight, require_project, TaskLease,
};
use crate::workflow::pr::pr_in_flight;
use crate::worktree;

/// Refuse a finalize while the task has a LIVE SESSION on its worktree: a held
/// orchestrator slot (a build/reviewer session is running or being dispatched —
/// the same probe `ensure_review_resolvable` uses) or an `InProgress`/
/// `Verifying` status (the slot may not be leased yet in the dispatch window,
/// e.g. `rerun_verification` just fired). The lease cross-checks below cover
/// sibling *commands*; this covers sibling *sessions* — without it a finalize
/// could force-delete the worktree out from under a running agent whose cwd is
/// that worktree. Pure (the probes are injected booleans), unit-testable.
pub(super) fn refuse_finalize_under_live_session(
    slot_leased: bool,
    status: TaskStatus,
) -> Result<(), String> {
    if slot_leased || matches!(status, TaskStatus::InProgress | TaskStatus::Verifying) {
        return Err(
            "a session is using this worktree — wait for it to finish before finalizing"
                .to_string(),
        );
    }
    Ok(())
}

/// Refuse a finalize while a PR action or commit holds the task — the mirror
/// checks for the merge-class lease `finalize_merged_pr` takes (its cleanup
/// deletes the worktree + branch, exactly what an in-flight push/commit is
/// standing in).
pub(super) fn refuse_finalize_while_sibling_in_flight(id: &str) -> Result<(), String> {
    if lease_held(pr_in_flight(), id) {
        return Err(
            "a PR action for this task is in progress — wait for it to finish before finalizing"
                .to_string(),
        );
    }
    if lease_held(commit_in_flight(), id) {
        return Err(
            "a commit for this task is in progress — wait for it to finish before finalizing"
                .to_string(),
        );
    }
    Ok(())
}

/// Close out a task whose PR was merged ON GitHub: verify `state == MERGED`
/// server-side, refuse if unpushed local commits would be destroyed, then
/// mirror the local merge's post-merge tail — honor `cleanup_worktrees`, set
/// `merged`, emit `nc:task`.
#[tauri::command]
pub async fn finalize_merged_pr(app: AppHandle, id: String) -> Result<(), String> {
    // `gh` view (up to 60s) + git cleanup — blocking-pool work.
    tauri::async_runtime::spawn_blocking(move || finalize_merged_pr_blocking(&app, &id))
        .await
        .map_err(|e| format!("finalize merged PR failed to run: {e}"))?
}

/// The blocking body of `finalize_merged_pr`: lease → cross-checks → the
/// testable core → emit.
fn finalize_merged_pr_blocking(app: &AppHandle, id: &str) -> Result<(), String> {
    // Merge-class action: it takes the MERGE lease (its cleanup is the merge
    // tail), so a local merge and a finalize can never race on one task.
    let _lease = TaskLease::acquire(merge_in_flight(), id)
        .ok_or_else(|| "a merge for this task is already in progress".to_string())?;
    refuse_finalize_while_sibling_in_flight(id)?;
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    // Live-session guard: the cleanup below force-deletes the worktree, so it
    // must never run under a live build/reviewer session (slot leased) or in
    // the `InProgress`/`Verifying` dispatch window.
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let orch = app
        .try_state::<crate::orchestration::coordinator::Orchestrator>()
        .ok_or_else(|| "orchestrator unavailable".to_string())?;
    refuse_finalize_under_live_session(orch.slots.is_leased(id), task.status)?;
    // Fix-arc cross-guard: the live-session probe above only sees the TASK's own
    // sessions (slot/status) — a PR-fix session reusing this task's worktree
    // holds no slot, so it needs its own refusal. The cleanup below would
    // force-delete the worktree out from under it.
    let fix_registry = app
        .try_state::<crate::workflow::pr_fix::PrFixRegistry>()
        .ok_or_else(|| "pr-fix registry unavailable".to_string())?;
    crate::workflow::pr_fix::refuse_while_fix_running(
        &fix_registry,
        task.pr_number,
        id,
        "finalizing",
    )?;
    let project = require_project(app)?;
    let project_path = PathBuf::from(&project.path);
    let cleanup = app
        .state::<SettingsStore>()
        .with_settings(|s| s.cleanup_worktrees);
    let updated = finalize_merged_core(&store, &project_path, id, GH_BINARY, cleanup)?;
    let _ = app.emit(TASK_EVENT, &updated);
    Ok(())
}

/// The finalize core, `AppHandle`-free so the whole verify → refuse → cleanup →
/// persist arc is testable against a temp repo + fake gh: re-verify the PR is
/// MERGED on GitHub (never trust the caller — the UI's last status snapshot may
/// be stale or forged), refuse when the worktree holds unpushed commits
/// (`worktree::remove` is `--force`; cleanup would silently destroy them), then
/// the exact post-merge tail of `merge_task_blocking`.
pub(super) fn finalize_merged_core(
    store: &TaskStore,
    project_path: &Path,
    id: &str,
    binary: &str,
    cleanup: bool,
) -> Result<Task, String> {
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let number = require_pr_number(&task)?;
    if task.merged {
        return Err("task is already merged — nothing to finalize".to_string());
    }

    // Server-side verification, from the worktree when it exists (else the
    // project root — same repo, same PR).
    let worktree_dir = worktree::worktree_path(project_path, id);
    let view_dir = if worktree_dir.exists() {
        worktree_dir.clone()
    } else {
        project_path.to_path_buf()
    };
    let view = fetch_pr_view_with(&view_dir, binary, number, GH_VIEW_TIMEOUT)?;
    if view.state != "MERGED" {
        return Err(format!(
            "PR #{number} is not merged on GitHub (state: {}) — merge it there first, or use the local merge",
            view.state
        ));
    }

    // Never destroy work: cleanup removes the worktree with `--force`, so local
    // commits that never reached the remote would be silently lost. FAIL CLOSED:
    // an unresolvable upstream (`Err`) refuses too — GitHub's auto-delete of the
    // merged head branch plus any prune fetch removes `origin/nc/<id>`, which
    // used to read as a tolerant 0 and let this cleanup destroy an unpushed
    // commit. Unknown ≠ zero.
    if worktree_dir.exists() {
        match worktree::try_ahead_of_upstream(&worktree_dir) {
            Ok(0) => {}
            Ok(unpushed) => {
                return Err(format!(
                    "the worktree has {unpushed} unpushed local commit(s) — push or discard them first"
                ));
            }
            Err(e) => {
                return Err(format!(
                    "cannot verify the branch was fully pushed — its upstream is gone; \
                     push again or discard the worktree manually ({e})"
                ));
            }
        }
    }

    // The post-merge tail of `merge_task_blocking`, verbatim: best-effort
    // cleanup honoring the setting (off ⇒ the worktree persists until the user
    // merges/discards it), then the merged flag.
    if cleanup {
        let branch = task
            .branch
            .clone()
            .unwrap_or_else(|| worktree::branch_name(id));
        let _ = worktree::remove(project_path, id);
        let _ = worktree::delete_branch_named(project_path, &branch);
    }
    tracing::info!(target: "nightcore::pr", task_id = %id, pr_number = number, cleaned_up = cleanup, "finalized remotely-merged PR");
    store.mutate(id, |t| {
        t.merged = true;
        t.conflict = false;
    })
}
