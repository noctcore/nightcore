//! The pr-fix `#[tauri::command]`s: the three fix STARTERS —
//! [`address_review_findings`] (selected review findings), [`fix_pr_ci`] (the
//! PR's failing checks), [`resolve_pr_conflicts`] (merge the base + resolve
//! conflicts) — each `checkout → fenced prompt → fix session`, plus
//! [`push_pr_fix`] (the human-gated plain push, optionally posting a summary
//! comment), [`list_pr_fixes`] (web reconcile), and [`cancel_pr_fix`]
//! (interrupt the live session).
//!
//! LEASE SEMANTICS (deliberate, mirrors `address_pr_comments`): the shared
//! PR-arc `pr_in_flight` `TaskLease` is RAII and held only across the SETUP
//! window (checkout resolution → dispatch) and again across the push — it is
//! NOT held for the session's whole runtime. The long-running exclusion is the
//! registry's `running` entry: `insert_running` atomically refuses a second fix
//! for the same PR, and the task-scoped PR actions refuse while the lease is
//! held during the windows that actually touch the checkout. Holding the RAII
//! lease across the session would require parking it somewhere the terminal
//! event can drop it — the registry state IS that parking spot, minus the
//! footgun.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::engine_api::EngineApi;
use crate::provider::{Provider, SidecarProvider};
use crate::store::pr_review::{PrReviewRun, PrReviewStore, StoredReviewFinding};
use crate::store::TaskStore;
use crate::task::{now_ms, TaskKind};
use crate::workflow::merge::{
    commit_in_flight, lease_held, merge_in_flight, require_project, TaskLease,
};
use crate::git::gh::GH_BINARY;
use crate::workflow::pr::pr_in_flight;
use crate::worktree;

use super::checkout::{
    fetch_pr_refs_with, managed_checkout, managed_lease_id, reusable_task_checkout,
};
use super::ci::{fetch_failing_checks_with, GH_CHECKS_TIMEOUT};
use super::complete::emit_state;
use super::conflicts::{abort_merge_best_effort, merge_base_into, MergeOutcome};
use super::prompt::{build_ci_prompt, build_conflicts_prompt, build_fix_prompt};
use super::state::{
    mint_fix_id, PrFixRegistry, PrFixState, KIND_CI, KIND_CONFLICTS, KIND_FINDINGS,
    STATUS_AWAITING_PUSH, STATUS_FAILED, STATUS_PUSHED, STATUS_RUNNING,
};

/// Wall-clock bound on the `gh pr view` refs read for the conflicts arc (a
/// single-object view moves no data).
const GH_REFS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

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
fn refuse_while_sibling_in_flight(lease_id: &str, before_what: &str) -> Result<(), String> {
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
struct FixCheckout {
    dir: PathBuf,
    branch: String,
    lease_id: String,
    _lease: TaskLease,
}

/// Resolve the checkout every fix STARTER shares: (a) reuse a task worktree
/// tracking this PR (refused while the task's OWN session is live on it — the
/// slot/status probe), else (b) a managed checkout of the PR head branch under
/// `.nightcore/pr-fix/pr-<n>` — acquiring the setup-window lease, refusing
/// sibling terminal actions, and best-effort provisioning deps so the session's
/// own check runs resolve package-local deps.
async fn resolve_fix_checkout(
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
fn new_fix_state(
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
async fn register_and_dispatch(
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

/// Run a fix session over selected PR-review findings, on the PR's branch.
/// Deliberately NOT a board task: the fix's lifecycle lives in the in-memory
/// [`PrFixRegistry`] (restart loses the registry entry, never the work — the
/// auto-commit survives in the checkout). Returns the fix id; progress arrives
/// as full [`PrFixState`] snapshots on `nc:pr-fix`.
#[tauri::command]
pub async fn address_review_findings(
    app: AppHandle,
    run_id: String,
    finding_ids: Vec<String>,
) -> Result<String, String> {
    // ── Selection (in-memory reads; nothing mutated yet). ──
    let run = app
        .state::<PrReviewStore>()
        .get(&run_id)
        .ok_or_else(|| format!("no PR review run with id {run_id}"))?;
    let findings = select_findings(&run, &finding_ids)?;
    let pr_number = run.pr_number;

    // Cheap early refusal for a duplicate fix on this PR; the ATOMIC guard is
    // `insert_running` inside `register_and_dispatch` (same lock as the insert).
    app.state::<PrFixRegistry>()
        .refuse_running_for_pr(pr_number)?;

    let project = require_project(&app)?;
    let project_path = PathBuf::from(&project.path);
    let checkout = resolve_fix_checkout(&app, &project_path, pr_number).await?;

    let prompt = build_fix_prompt(pr_number, &checkout.branch, &findings);
    let state = new_fix_state(
        KIND_FINDINGS,
        Some(run_id),
        pr_number,
        &checkout.branch,
        &checkout.dir,
        findings.len() as u32,
        STATUS_RUNNING,
        None,
    );
    register_and_dispatch(&app, state, &checkout.lease_id, prompt).await
}

/// Run a fix session over the PR's FAILING CI checks, on the PR's branch. Reads
/// the failing checks from `gh pr checks` (refusing when none are failing —
/// nothing to burn a paid session on), then follows the exact
/// [`address_review_findings`] arc: checkout → fenced prompt → registered
/// session → auto-commit → human-gated push.
#[tauri::command]
pub async fn fix_pr_ci(app: AppHandle, pr_number: u64) -> Result<String, String> {
    if pr_number == 0 {
        return Err("no PR number to fix CI for (a positive integer is required)".to_string());
    }
    app.state::<PrFixRegistry>()
        .refuse_running_for_pr(pr_number)?;
    let project = require_project(&app)?;
    let project_path = PathBuf::from(&project.path);

    // Read the failing checks BEFORE any checkout work — a PR with green checks
    // refuses cheaply. Blocking `gh` network work, off the UI thread.
    let checks_dir = project_path.clone();
    let checks = tauri::async_runtime::spawn_blocking(move || {
        fetch_failing_checks_with(&checks_dir, GH_BINARY, pr_number, GH_CHECKS_TIMEOUT)
    })
    .await
    .map_err(|e| format!("reading the PR's checks failed to run: {e}"))??;
    if checks.is_empty() {
        return Err(format!(
            "PR #{pr_number} has no failing checks — nothing to fix (refresh the status if \
             GitHub shows otherwise)"
        ));
    }

    let checkout = resolve_fix_checkout(&app, &project_path, pr_number).await?;
    let prompt = build_ci_prompt(pr_number, &checkout.branch, &checks);
    let state = new_fix_state(
        KIND_CI,
        None,
        pr_number,
        &checkout.branch,
        &checkout.dir,
        checks.len() as u32,
        STATUS_RUNNING,
        None,
    );
    register_and_dispatch(&app, state, &checkout.lease_id, prompt).await
}

/// Resolve the PR's merge conflicts against its base branch: merge
/// `refs/remotes/origin/<base>` into the PR checkout, and — when the merge
/// stops on conflicts — run a fix session that resolves the conflicted files
/// (the auto-commit then CONCLUDES the in-progress merge). A merge that
/// completes cleanly needs no session at all: the merge commit parks straight
/// at `awaiting_push`. A branch already up to date with base refuses (there is
/// nothing to resolve).
#[tauri::command]
pub async fn resolve_pr_conflicts(app: AppHandle, pr_number: u64) -> Result<String, String> {
    if pr_number == 0 {
        return Err(
            "no PR number to resolve conflicts for (a positive integer is required)".to_string(),
        );
    }
    let registry = app.state::<PrFixRegistry>();
    registry.refuse_running_for_pr(pr_number)?;
    let project = require_project(&app)?;
    let project_path = PathBuf::from(&project.path);

    // Head + base + fork refusal in ONE bounded `gh pr view` (the conflicts arc
    // is the only starter that needs the BASE ref).
    let refs_dir = project_path.clone();
    let refs = tauri::async_runtime::spawn_blocking(move || {
        fetch_pr_refs_with(&refs_dir, GH_BINARY, pr_number, GH_REFS_TIMEOUT)
    })
    .await
    .map_err(|e| format!("reading the pull request failed to run: {e}"))??;

    let checkout = resolve_fix_checkout(&app, &project_path, pr_number).await?;

    // Fetch the base (so its remote-tracking ref is current) and attempt the
    // merge — blocking network/git work.
    let base = refs.base.clone();
    let fetch_root = project_path.clone();
    let merge_dir = checkout.dir.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        crate::worktree::fetch_base(&fetch_root, &base)?;
        merge_base_into(&merge_dir, &base)
    })
    .await
    .map_err(|e| format!("the merge failed to run: {e}"))??;

    match outcome {
        MergeOutcome::AlreadyUpToDate => Err(format!(
            "PR #{pr_number}'s branch already contains `{}` — no conflicts to resolve \
             (refresh the status if GitHub still shows conflicts)",
            refs.base
        )),
        MergeOutcome::Clean => {
            // The merge committed cleanly — no session to run. Park the fix at
            // its human push gate directly. If the atomic insert refuses (a
            // racing fix registered first), the local merge commit stays on the
            // branch in the checkout — unpushed and harmless (a re-run then
            // reports "already up to date").
            let state = new_fix_state(
                KIND_CONFLICTS,
                None,
                pr_number,
                &checkout.branch,
                &checkout.dir,
                0,
                STATUS_AWAITING_PUSH,
                Some(format!(
                    "Merged `origin/{}` cleanly — no conflicting hunks. The merge commit is \
                     ready to push.",
                    refs.base
                )),
            );
            registry.insert_running(state.clone(), &checkout.lease_id)?;
            emit_state(&app, &state);
            tracing::info!(
                target: "nightcore::prfix",
                fix_id = %state.id,
                pr_number,
                base = %refs.base,
                "base merged cleanly; merge commit awaiting push"
            );
            Ok(state.id)
        }
        MergeOutcome::Conflicted(files) => {
            let prompt = build_conflicts_prompt(pr_number, &checkout.branch, &refs.base, &files);
            let state = new_fix_state(
                KIND_CONFLICTS,
                None,
                pr_number,
                &checkout.branch,
                &checkout.dir,
                files.len() as u32,
                STATUS_RUNNING,
                None,
            );
            let dir = checkout.dir.clone();
            match register_and_dispatch(&app, state, &checkout.lease_id, prompt).await {
                Ok(fix_id) => Ok(fix_id),
                Err(e) => {
                    // The checkout sits mid-merge and no session will resolve it
                    // — abort so it is never left wedged. Blocking git, but a
                    // local-only op.
                    let _ =
                        tauri::async_runtime::spawn_blocking(move || abort_merge_best_effort(&dir))
                            .await;
                    Err(e)
                }
            }
        }
    }
}

/// Start the fix session: correlation id = the FIX id (the reader intercept's
/// routing key), `kind=build` over the checkout, default permission mode, and
/// project-scoped guardrails (no per-task ceilings — a pr-fix has no task).
async fn dispatch_fix_session(
    app: &AppHandle,
    fix_id: &str,
    prompt: String,
    dir: &Path,
) -> Result<(), String> {
    crate::sidecar::ensure_reader(app).await?;
    let provider = app.state::<Arc<SidecarProvider>>();
    let permission_mode = crate::sidecar::resolve_permission_mode(app, None);
    provider
        .start_session(
            fix_id,
            prompt,
            // Model/effort: core defaults (no task to inherit from).
            None,
            None,
            Some(dir.to_path_buf()),
            permission_mode,
            TaskKind::Build.as_wire(),
            // No image attachments: the fix works from the findings text.
            Vec::new(),
            fix_guardrails(app, fix_id),
        )
        .await
}

/// The project-scoped [`Guardrails`](crate::provider::Guardrails) for a pr-fix
/// session: the reviewer/fix sub-run shape (`dispatch_build_fix`) minus the
/// per-task ceilings — a pr-fix has no task, so `max_turns`/`max_budget_usd`
/// inherit the `@nightcore/config` defaults and it is never resumed. The
/// flight-recorder ledger is keyed by the fix id (its own file beside the task
/// ledgers).
fn fix_guardrails(app: &AppHandle, fix_id: &str) -> crate::provider::Guardrails {
    crate::provider::Guardrails {
        max_turns: None,
        max_budget_usd: None,
        resume_session_id: None,
        mcp_servers: crate::sidecar::resolve_mcp_servers(app),
        append_context_pack: crate::sidecar::resolve_context_pack(app),
        harness_policy: crate::sidecar::resolve_harness_policy(app),
        ledger_path: crate::sidecar::resolve_ledger_path(app, fix_id),
        sandbox_writes: crate::sidecar::resolve_sandbox_writes(app),
    }
}

/// Push an `awaiting_push` fix's branch to origin — the HUMAN GATE. Plain push,
/// NEVER `--force` (the abort-not-force philosophy; a diverged remote fails
/// loudly). Re-acquires the same `pr_in_flight` lease id the setup used.
///
/// `post_comment` (the push dialog's checkbox) additionally posts one summary
/// comment on the PR explaining how the fix addressed its targets. The comment
/// is BEST-EFFORT: the push has already landed when it runs, so a comment
/// failure returns `Ok(Some(warning))` — never a push "failure".
#[tauri::command]
pub async fn push_pr_fix(
    app: AppHandle,
    fix_id: String,
    post_comment: Option<bool>,
) -> Result<Option<String>, String> {
    // The push talks to the network (up to 120s) — blocking-pool work.
    tauri::async_runtime::spawn_blocking(move || {
        push_pr_fix_blocking(&app, &fix_id, post_comment.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("push PR fix failed to run: {e}"))?
}

/// The blocking body of [`push_pr_fix`]: lookup → precondition → lease →
/// re-check → bounded push → `pushed` + emit → (optional) summary comment.
fn push_pr_fix_blocking(
    app: &AppHandle,
    fix_id: &str,
    post_comment: bool,
) -> Result<Option<String>, String> {
    let registry = app
        .try_state::<PrFixRegistry>()
        .ok_or_else(|| "pr-fix registry unavailable".to_string())?;
    let state = registry.get(fix_id).ok_or_else(|| {
        format!(
            "no PR fix with id {fix_id} — fixes don't survive an app restart (the commit is \
             still on the branch in its checkout; push it manually)"
        )
    })?;
    check_push_preconditions(&state)?;
    let lease_id = registry
        .lease_id_for(fix_id)
        .ok_or_else(|| format!("no PR fix with id {fix_id}"))?;
    // The same lease id the setup used: mutual exclusion with the task-scoped
    // PR actions (and a double-fired push serializes with itself here).
    let _lease = TaskLease::acquire(pr_in_flight(), &lease_id)
        .ok_or_else(|| "a PR action for this pull request is already in progress".to_string())?;
    refuse_while_sibling_in_flight(&lease_id, "pushing the fix")?;
    // Re-check under the lease: a racing push that won the lease first has
    // already flipped the status to `pushed`.
    let state = registry
        .get(fix_id)
        .ok_or_else(|| format!("no PR fix with id {fix_id}"))?;
    check_push_preconditions(&state)?;

    // Bounded plain push (validates the ref again inside; `-u` sets upstream).
    worktree::push_branch(Path::new(&state.dir), &state.branch)?;

    let updated = registry.transition(fix_id, STATUS_AWAITING_PUSH, |s| {
        s.status = STATUS_PUSHED.to_string();
        s.error = None;
    })?;
    tracing::info!(target: "nightcore::prfix", fix_id, pr_number = updated.pr_number, branch = %updated.branch, "pr-fix pushed to origin");
    emit_state(app, &updated);

    // The opt-in summary comment — AFTER the push landed and the state settled,
    // so a comment failure can only ever be a warning on a successful push.
    if post_comment {
        let dir = Path::new(&updated.dir);
        let body = super::comment::compose_push_comment(
            &updated,
            super::comment::head_short_sha(dir).as_deref(),
        );
        if let Err(e) = super::comment::post_push_comment_with(
            dir,
            GH_BINARY,
            updated.pr_number,
            &body,
            super::comment::GH_COMMENT_TIMEOUT,
        ) {
            tracing::warn!(target: "nightcore::prfix", fix_id, pr_number = updated.pr_number, error = %e, "pushed, but the summary comment failed");
            return Ok(Some(format!(
                "the fix was pushed, but posting the summary comment failed: {e}"
            )));
        }
        tracing::info!(target: "nightcore::prfix", fix_id, pr_number = updated.pr_number, "summary comment posted");
    }
    Ok(None)
}

/// Every registered fix, newest first — the web's reconcile read (pure
/// in-memory, safe as a sync command).
#[tauri::command]
pub fn list_pr_fixes(registry: State<'_, PrFixRegistry>) -> Vec<PrFixState> {
    registry.list()
}

/// Dismiss a SETTLED fix from the registry — the user's escape hatch for a
/// stale `awaiting_push` entry (whose presence blocks both a new fix for the PR
/// and the task-side `push_pr_updates`), or for clearing `pushed`/`failed`
/// history. Refuses a live (`running`/`committing`) fix: cancel it instead.
/// The branch commit (if any) is untouched — dismissing only forgets the
/// registry entry, exactly like an app restart would.
#[tauri::command]
pub fn dismiss_pr_fix(registry: State<'_, PrFixRegistry>, fix_id: String) -> Result<(), String> {
    let removed = registry.remove_settled(&fix_id)?;
    tracing::info!(target: "nightcore::prfix", fix_id = %fix_id, pr_number = removed.pr_number, status = %removed.status, "pr-fix dismissed");
    Ok(())
}

/// Cancel a running fix: fail-close its parked permission requests, interrupt
/// the live session via the provider correlation (the `cancel_task` seam keyed
/// by the fix id), and mark it failed("cancelled") at once — the session's own
/// later `session-failed (aborted)` terminal is then a silent no-op in the
/// reader intercept. A `committing` fix is PAST cancel (its session already
/// finished and the auto-commit is claiming the checkout — see
/// `handle_fix_completed`'s CAS): the status refusal below names it.
#[tauri::command]
pub async fn cancel_pr_fix(
    app: AppHandle,
    provider: State<'_, Arc<SidecarProvider>>,
    engine: State<'_, Arc<dyn EngineApi>>,
    fix_id: String,
) -> Result<(), String> {
    let registry = app.state::<PrFixRegistry>();
    let state = registry
        .get(&fix_id)
        .ok_or_else(|| format!("no PR fix with id {fix_id}"))?;
    if state.status != STATUS_RUNNING {
        return Err(format!(
            "this fix is not running (status: {})",
            state.status
        ));
    }
    // Fail-closed: deny any permission request parked for this fix before the
    // interrupt, so a session waiting on an approval can't hang (the
    // cancel_task discipline — the engine registry is keyed by the correlation
    // id, which for a fix session is the fix id).
    engine.deny_parked_permissions(&app, &fix_id).await;

    if let Some(session_id) = provider.session_for(&fix_id) {
        // Best-effort: even if the interrupt errs, we mark the fix failed below
        // — a session that completes anyway finds the state already terminal
        // and skips the auto-commit (see `handle_fix_completed`).
        if let Err(e) = provider.interrupt(session_id).await {
            tracing::warn!(target: "nightcore::prfix", fix_id = %fix_id, error = %e, "pr-fix interrupt failed; marking cancelled anyway");
        }
    } else {
        // No correlated session yet: evict the pending launch so a later,
        // unrelated `session-started` can't mis-bind to this cancelled launch
        // (the cancel_task rule).
        provider.evict_pending(&fix_id);
    }

    if let Some(updated) = registry.mark_failed_if_running(&fix_id, "cancelled".to_string()) {
        emit_state(&app, &updated);
    }
    // A cancelled CONFLICTS fix leaves its checkout mid-merge (MERGE_HEAD +
    // conflict markers) — abort it so later checkout ops aren't wedged behind
    // a merge the user explicitly walked away from. Best-effort, local git.
    if state.kind == KIND_CONFLICTS {
        let dir = PathBuf::from(&state.dir);
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if super::conflicts::merge_in_progress(&dir) {
                abort_merge_best_effort(&dir);
            }
        })
        .await;
    }
    tracing::info!(target: "nightcore::prfix", fix_id = %fix_id, "pr-fix cancelled");
    Ok(())
}
