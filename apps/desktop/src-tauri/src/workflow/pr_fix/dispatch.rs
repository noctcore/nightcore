//! The shared, non-command plumbing behind the pr-fix STARTERS: finding
//! selection, the push/sibling-lease preconditions, checkout resolution, fresh
//! [`PrFixState`] assembly, and the register→dispatch tail all three fix kinds
//! run through. Split out of `command.rs` (issue #17 D) so the command surface
//! stays a thin file; every item is `pub(super)` — internal to `pr_fix`, reached
//! from `command.rs` (and the source-guard tests) via `super::dispatch::…`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::engine_api::SessionDispatch;
use crate::provider::{Provider, SidecarProvider};
use crate::store::pr_review::{PrReviewRun, StoredReviewFinding};
use crate::store::TaskStore;
use crate::task::now_ms;
use crate::workflow::merge::{commit_in_flight, lease_held, merge_in_flight, TaskLease};
use crate::workflow::pr::pr_in_flight;
use crate::worktree;

use super::checkout::{managed_checkout, managed_lease_id, reusable_task_checkout};
use super::complete::emit_state;
use super::state::{mint_fix_id, PrFixRegistry, PrFixState, STATUS_AWAITING_PUSH, STATUS_FAILED};

/// Wall-clock bound on the `gh pr view` refs read for the conflicts arc (a
/// single-object view moves no data).
pub(super) const GH_REFS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Select the named findings out of a review run (order = the run's order,
/// duplicates in `finding_ids` collapse naturally). Errs when NONE resolve — a
/// fix session with zero findings would burn a paid run on an empty prompt.
/// Pure — unit-tested.
pub(super) fn select_findings(
    run: &PrReviewRun,
    finding_ids: &[String],
) -> Result<Vec<StoredReviewFinding>, String> {
    let selected: Vec<StoredReviewFinding> = run
        .findings
        .iter()
        .filter(|f| finding_ids.iter().any(|id| id == &f.id))
        .cloned()
        .collect();
    if selected.is_empty() {
        return Err(
            "none of the selected findings exist in this review run — refresh and retry"
                .to_string(),
        );
    }
    Ok(selected)
}

/// The push precondition: only an `awaiting_push` fix may push. Pure — unit-tested.
pub(super) fn check_push_preconditions(state: &PrFixState) -> Result<(), String> {
    if state.status != STATUS_AWAITING_PUSH {
        return Err(format!(
            "this fix is not awaiting push (status: {})",
            state.status
        ));
    }
    Ok(())
}

/// Refuse a pr-fix action while a sibling terminal action (merge / commit)
/// holds the lease id — only meaningful when the checkout is a TASK's worktree
/// (the lease id is then that task's id; a completing merge force-deletes the
/// worktree out from under the session/push). Checked AFTER the PR lease is
/// acquired, the same ordering discipline as the PR-arc siblings. For a managed
/// `pr-<n>` lease id these sets never match — a harmless no-op.
pub(super) fn refuse_while_sibling_in_flight(
    lease_id: &str,
    before_what: &str,
) -> Result<(), String> {
    if lease_held(merge_in_flight(), lease_id) {
        return Err(format!(
            "a merge for this task is in progress — wait for it to finish before {before_what}"
        ));
    }
    if lease_held(commit_in_flight(), lease_id) {
        return Err(format!(
            "a commit for this task is in progress — wait for it to finish before {before_what}"
        ));
    }
    Ok(())
}

/// A resolved fix checkout: where the session runs, which branch it works, the
/// `pr_in_flight` key its setup leased, and the held RAII lease itself (dropped
/// when the starting command returns — see the module-doc LEASE SEMANTICS).
pub(super) struct FixCheckout {
    pub(super) dir: PathBuf,
    pub(super) branch: String,
    pub(super) lease_id: String,
    pub(super) _lease: TaskLease,
}

/// Resolve the checkout every fix STARTER shares: (a) reuse a task worktree
/// tracking this PR (refused while the task's OWN session is live on it — the
/// slot/status probe), else (b) a managed checkout of the PR head branch under
/// `.nightcore/pr-fix/pr-<n>` — acquiring the setup-window lease, refusing
/// sibling terminal actions, and best-effort provisioning deps so the session's
/// own check runs resolve package-local deps.
pub(super) async fn resolve_fix_checkout(
    app: &AppHandle,
    project_path: &Path,
    pr_number: u64,
) -> Result<FixCheckout, String> {
    let orch = app.state::<crate::orchestration::coordinator::Orchestrator>();
    let reuse = reusable_task_checkout(&app.state::<TaskStore>(), project_path, pr_number, |id| {
        orch.slots.is_leased(id)
    })?;
    let lease_id = match &reuse {
        Some(checkout) => checkout.lease_id.clone(),
        None => managed_lease_id(pr_number),
    };

    // Setup-window lease (see the module-doc LEASE SEMANTICS): serializes this
    // setup against the task-scoped PR actions (create/push/finalize/address)
    // on the same checkout, dropped when the starting command returns.
    let lease = TaskLease::acquire(pr_in_flight(), &lease_id)
        .ok_or_else(|| "a PR action for this pull request is already in progress".to_string())?;
    refuse_while_sibling_in_flight(&lease_id, "starting a PR fix")?;

    let (dir, branch) = match reuse {
        Some(checkout) => (checkout.dir, checkout.branch),
        None => {
            // `gh` + `git fetch` + `git worktree add` — blocking network/disk
            // work, kept off the UI thread (the WKWebView rule).
            let checkout_path = project_path.to_path_buf();
            tauri::async_runtime::spawn_blocking(move || {
                managed_checkout(&checkout_path, pr_number)
            })
            .await
            .map_err(|e| format!("PR checkout failed to run: {e}"))??
        }
    };

    // Best-effort dep provisioning so the session's own check runs resolve
    // package-local deps; a failure is warned and the fix proceeds (the same
    // tolerance as the reviewer gauntlet's provisioning).
    let provision_dir = dir.clone();
    match tauri::async_runtime::spawn_blocking(move || worktree::provision_deps(&provision_dir))
        .await
    {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            tracing::warn!(target: "nightcore::prfix", error = %e, "pr-fix dep provisioning failed; continuing")
        }
        Err(e) => {
            tracing::warn!(target: "nightcore::prfix", error = %e, "pr-fix dep provisioning failed to run; continuing")
        }
    }

    Ok(FixCheckout {
        dir,
        branch,
        lease_id,
        _lease: lease,
    })
}

/// Assemble a fresh [`PrFixState`] for a starting fix.
#[allow(clippy::too_many_arguments)]
pub(super) fn new_fix_state(
    kind: &str,
    run_id: Option<String>,
    pr_number: u64,
    branch: &str,
    dir: &Path,
    finding_count: u32,
    status: &str,
    summary: Option<String>,
) -> PrFixState {
    let now = now_ms();
    PrFixState {
        id: mint_fix_id(),
        kind: kind.to_string(),
        run_id,
        pr_number,
        branch: branch.to_string(),
        dir: dir.to_string_lossy().to_string(),
        status: status.to_string(),
        summary,
        error: None,
        finding_count,
        created_at: now,
        updated_at: now,
    }
}

/// Register a `running` fix (the atomic same-PR guard) + emit, dispatch its
/// session, and close the cancel-vs-dispatch window. Returns the fix id.
pub(super) async fn register_and_dispatch(
    app: &AppHandle,
    state: PrFixState,
    lease_id: &str,
    prompt: String,
) -> Result<String, String> {
    let registry = app.state::<PrFixRegistry>();
    let dir = PathBuf::from(&state.dir);
    registry.insert_running(state.clone(), lease_id)?;
    emit_state(app, &state);
    let fix_id = state.id.clone();

    if let Err(e) = dispatch_fix_session(app, &fix_id, prompt, &dir).await {
        // Dispatch failure: mark failed + emit so the UI never shows a phantom
        // running fix; the lease releases on return (RAII).
        if let Some(failed) = registry
            .mark_failed_if_running(&fix_id, format!("could not start the fix session: {e}"))
        {
            emit_state(app, &failed);
        }
        return Err(e);
    }
    // Cancel-vs-dispatch window: a `cancel_pr_fix` that landed between
    // `insert_running` and the dispatch above marked the fix failed but found
    // neither a correlated session (`session_for`) nor a pending launch to evict
    // — leaving the session we JUST launched running unmanaged. Re-check the
    // registry and best-effort interrupt (or evict the still-pending launch) so
    // a cancelled fix never keeps burning a paid session.
    if registry
        .get(&fix_id)
        .is_some_and(|s| s.status == STATUS_FAILED)
    {
        let provider = app.state::<Arc<SidecarProvider>>();
        if let Some(session_id) = provider.session_for(&fix_id) {
            if let Err(e) = provider.interrupt(session_id).await {
                tracing::warn!(target: "nightcore::prfix", fix_id = %fix_id, error = %e, "interrupt of a cancelled-during-dispatch fix session failed");
            }
        } else {
            provider.evict_pending(&fix_id);
        }
        tracing::warn!(target: "nightcore::prfix", fix_id = %fix_id, "pr-fix was cancelled during dispatch; interrupted the just-launched session");
        return Err("the fix was cancelled before its session started".to_string());
    }
    tracing::info!(
        target: "nightcore::prfix",
        fix_id = %fix_id,
        pr_number = state.pr_number,
        kind = %state.kind,
        targets = state.finding_count,
        branch = %state.branch,
        "pr-fix session dispatched"
    );
    Ok(fix_id)
}

/// Start the fix session: correlation id = the FIX id (the reader intercept's
/// routing key), `kind=build` over the checkout, default permission mode, and
/// project-scoped guardrails (no per-task ceilings — a pr-fix has no task). The
/// dispatch itself lives sidecar-side (`dispatch_pr_fix_build`), reached through
/// the managed [`SessionDispatch`] seam (issue #33) — workflow never names
/// `crate::sidecar`.
pub(super) async fn dispatch_fix_session(
    app: &AppHandle,
    fix_id: &str,
    prompt: String,
    dir: &Path,
) -> Result<(), String> {
    app.state::<Arc<dyn SessionDispatch>>()
        .dispatch_pr_fix_build(app, fix_id, prompt, dir)
        .await
}
