//! The reader-side terminal handlers for a pr-fix session, reached through the
//! `sidecar::reader` intercept (a fix session's correlation id is a
//! [`PrFixRegistry`] key, not a task id): [`handle_fix_completed`] auto-commits
//! the session's edits onto the PR branch and parks the fix `awaiting_push`
//! (the human gate); [`handle_fix_failed`] marks it failed. Both emit the full
//! updated [`PrFixState`] on `nc:pr-fix`.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager};

use super::conflicts::{
    abort_merge_best_effort, files_with_markers, merge_in_progress, unmerged_paths,
};
use super::state::{
    PrFixRegistry, PrFixState, KIND_CI, KIND_CONFLICTS, STATUS_AWAITING_PUSH, STATUS_COMMITTING,
    STATUS_FAILED, STATUS_RUNNING,
};

/// Emit the full state snapshot on the `nc:pr-fix` channel (the web reconciles
/// via `list_pr_fixes` and folds these). Best-effort, like every UI emit.
pub(super) fn emit_state(app: &AppHandle, state: &PrFixState) {
    if let Err(e) = app.emit(crate::sidecar::PRFIX_EVENT, state) {
        tracing::warn!(target: "nightcore::prfix", fix_id = %state.id, error = %e, "failed to emit nc:pr-fix state");
    }
}

/// A pr-fix session completed: CLAIM the fix (CAS `running → committing`),
/// commit whatever it left in the checkout (`Ok(true)` = a commit was created,
/// `Ok(false)` = clean tree — BOTH park the fix `awaiting_push`; only a commit
/// ERROR fails it), store the session's result summary, and emit the updated
/// state on every transition.
///
/// The claim closes the cancel-vs-commit TOCTOU: the old read-check-then-commit
/// let a `cancel_pr_fix` slip between the status read and the blocking `git
/// commit`, committing a checkout the user had already cancelled. Now the CAS
/// happens FIRST — a lost CAS (the fix is unknown, cancelled, or superseded)
/// skips the commit entirely, and a cancel arriving AFTER the claim is refused
/// (`mark_failed_if_running` is running-only: a `committing` fix is past
/// cancel; the commit settles it to `awaiting_push`/`failed`).
pub(crate) async fn handle_fix_completed(
    app: &AppHandle,
    fix_id: &str,
    summary: Option<String>,
    cost_usd: Option<f64>,
) {
    let registry = app.state::<PrFixRegistry>();
    let state = match registry.transition(fix_id, STATUS_RUNNING, |s| {
        s.status = STATUS_COMMITTING.to_string();
    }) {
        Ok(state) => {
            emit_state(app, &state);
            state
        }
        // Lost CAS: cancelled/superseded (or unknown) — the checkout is NOT
        // committed after the user cancelled.
        Err(e) => {
            tracing::info!(target: "nightcore::prfix", fix_id, error = %e, "pr-fix completion superseded (not running); skipping commit");
            return;
        }
    };

    // The auto-commit is blocking git work — run it on the blocking pool (the
    // reader already offloaded us off its task, but this thread is still a
    // shared async worker). A CONFLICTS fix validates the resolution FIRST:
    // the commit's `git add -A` would happily stage half-resolved files (with
    // their markers) as "resolved", so leftover markers refuse the commit.
    let dir = PathBuf::from(&state.dir);
    let message = commit_message(&state);
    let is_conflicts = state.kind == KIND_CONFLICTS;
    let committed = tauri::async_runtime::spawn_blocking(move || {
        if is_conflicts {
            validate_conflicts_resolved(&dir)?;
        }
        crate::worktree::commit_in(&dir, &message)
    })
    .await
    .map_err(|e| format!("commit failed to run: {e}"))
    .and_then(|inner| inner);

    let updated = match committed {
        Ok(created) => {
            tracing::info!(
                target: "nightcore::prfix",
                fix_id,
                pr_number = state.pr_number,
                commit_created = created,
                cost_usd = cost_usd.unwrap_or(0.0),
                "pr-fix session completed; awaiting human-gated push"
            );
            registry.transition(fix_id, STATUS_COMMITTING, |s| {
                s.status = STATUS_AWAITING_PUSH.to_string();
                s.summary = summary;
                s.error = None;
            })
        }
        Err(e) => {
            tracing::error!(target: "nightcore::prfix", fix_id, error = %e, "pr-fix auto-commit failed");
            registry.transition(fix_id, STATUS_COMMITTING, |s| {
                s.status = STATUS_FAILED.to_string();
                s.summary = summary;
                s.error = Some(format!(
                    "the fix session completed but the auto-commit failed: {e}"
                ));
            })
        }
    };
    match updated {
        Ok(state) => emit_state(app, &state),
        // The `committing` claim above makes this effectively unreachable (we
        // are the only committing→terminal writer, cancel refuses committing,
        // dismiss refuses live fixes) — tolerate, never panic.
        Err(e) => {
            tracing::warn!(target: "nightcore::prfix", fix_id, error = %e, "pr-fix completion transition refused")
        }
    }
}

/// The kind-aware auto-commit message.
pub(super) fn commit_message(state: &PrFixState) -> String {
    match state.kind.as_str() {
        KIND_CI => format!("fix: address failing CI checks (PR #{})", state.pr_number),
        KIND_CONFLICTS => format!(
            "merge: resolve conflicts with base (PR #{})",
            state.pr_number
        ),
        _ => format!("fix: address PR review findings (PR #{})", state.pr_number),
    }
}

/// Refuse committing a `conflicts` fix whose still-unmerged files carry
/// leftover conflict markers. The checkout is deliberately left MID-MERGE with
/// the agent's partial work intact (aborting would destroy it) — the error
/// tells the user where to finish by hand.
fn validate_conflicts_resolved(dir: &Path) -> Result<(), String> {
    let unmerged = unmerged_paths(dir)?;
    let leftover = files_with_markers(dir, &unmerged);
    if leftover.is_empty() {
        return Ok(());
    }
    Err(format!(
        "conflict markers remain in {} — the partial resolution was kept in `{}`; finish \
         resolving there by hand (then commit), or run `git merge --abort` to discard it",
        leftover.join(", "),
        dir.display()
    ))
}

/// A pr-fix session failed (or was aborted): mark the fix failed and emit. A
/// no-op when the fix already left `running` — the cancel command marks
/// `failed("cancelled")` eagerly, so the session's own later
/// `session-failed (aborted)` terminal lands here as a silent duplicate (the
/// cancel path also owns that flow's merge-abort cleanup).
pub(crate) fn handle_fix_failed(app: &AppHandle, fix_id: &str, message: Option<String>) {
    let registry = app.state::<PrFixRegistry>();
    let error = message.unwrap_or_else(|| "the fix session failed".to_string());
    if let Some(state) = registry.mark_failed_if_running(fix_id, error) {
        tracing::warn!(target: "nightcore::prfix", fix_id, error = %state.error.as_deref().unwrap_or(""), "pr-fix session failed");
        emit_state(app, &state);
        // A DIED conflicts session leaves its checkout mid-merge with unresolved
        // markers and no agent coming back — abort so the checkout isn't wedged.
        // (Distinct from the completion path's marker refusal, which keeps the
        // finished agent's partial work.) Fire-and-forget local git.
        if state.kind == KIND_CONFLICTS {
            let dir = PathBuf::from(&state.dir);
            tauri::async_runtime::spawn_blocking(move || {
                if merge_in_progress(&dir) {
                    abort_merge_best_effort(&dir);
                }
            });
        }
    }
}
