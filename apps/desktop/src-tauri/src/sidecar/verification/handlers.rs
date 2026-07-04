//! The verification gate's terminal-event handlers: build-completed (commit, gate
//! the Structure-Lock Gauntlet, dispatch the reviewer) and review-completed (route
//! the verdict to done / bounded auto-fix / park-for-approval).

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::kind;
use crate::project::ProjectStore;
use crate::provider::SidecarProvider;
use crate::store::types::StructureLockResult;
use crate::store::TaskStore;
use crate::task::{ProposedSubtask, Task, TaskKind, TaskStatus};
use crate::worktree;

use crate::sidecar::{apply_and_emit, finish_run, park_for_approval, Outcome};

use super::dispatch::{dispatch_fix, dispatch_reviewer, MAX_FIX_ATTEMPTS};
use super::verdict::{merge_proposed_subtasks, parse_verdict, Verdict};

/// A build (or fix-build) session completed (M4 §B step 1). If the task's kind is
/// not verified-after — or there is no worktree to diff — finish exactly as M3
/// (`Done`, `finish_run(Succeeded)`). Otherwise enter the verification gate: set
/// `Verifying`, hold the slot+worktree, and dispatch a reviewer session over the
/// same worktree.
pub(crate) async fn handle_build_completed(
    app: &AppHandle,
    store: &TaskStore,
    task_id: &str,
    session_id: Option<u64>,
    result: Option<String>,
    cost: Option<f64>,
    proposed_subtasks: Vec<ProposedSubtask>,
) {
    let Some(task) = store.get(task_id) else {
        return;
    };
    let verify_after = kind::policy(task.kind).verify_after;
    let review_dir = verification_dir(app, task_id);

    if !verify_after || review_dir.is_none() {
        // M3 behavior: nothing to verify (no policy, or no project to review in).
        tracing::info!(target: "nightcore", task_id, session_id = ?session_id, cost_usd = ?cost, "task done (no verification)");
        // Decompose §B: the engine emits a validated `proposedSubtasks` array on the
        // `session-completed` event; the reader already built it into
        // `proposed_subtasks` (minting each id/status/link). Merge it with the task's
        // existing proposals so the detail view can offer them for conversion. Other
        // kinds carry an empty array and leave the list empty.
        let proposed = if task.kind == TaskKind::Decompose {
            // Preserve proposals already converted into board tasks across a re-run
            // (drag Done→Backlog → Run) so we never orphan a converted child or lose
            // its `linked_task_id`; the fresh proposals are appended after them.
            let merged = merge_proposed_subtasks(&task.proposed_subtasks, proposed_subtasks);
            tracing::info!(target: "nightcore", task_id, count = merged.len(), "decompose proposed sub-tasks");
            merged
        } else {
            Vec::new()
        };
        apply_and_emit(app, store, task_id, |task| {
            task.status = TaskStatus::Done;
            task.summary = result.clone();
            task.cost_usd = cost;
            task.session_id = session_id;
            task.error = None;
            if task.kind == TaskKind::Decompose {
                task.proposed_subtasks = proposed.clone();
            }
        });
        finish_run(app, task_id, session_id, Outcome::Succeeded);
        return;
    }

    let review_dir = review_dir.expect("checked is_some above");

    // M4.6 §A: in worktree mode the build leaves its edits UNCOMMITTED in the
    // worktree, then the reviewer's `base...HEAD` range is empty — the dogfood bug.
    // Commit the build's work first (message from the task title) so the branch's
    // HEAD advances and the diff is real. A clean tree commits nothing (a no-op,
    // distinct from a genuine empty result). Main mode has no branch — the reviewer
    // judges the working tree vs HEAD in the project root, so no commit here.
    if review_dir.is_worktree {
        if let Some(project) = app.state::<ProjectStore>().active() {
            let message = build_commit_message(&task);
            match worktree::commit(&PathBuf::from(&project.path), task_id, &message) {
                Ok(true) => {
                    tracing::info!(target: "nightcore", task_id, "committed build work before review")
                }
                Ok(false) => {
                    tracing::info!(target: "nightcore", task_id, "no build changes to commit before review (clean tree)")
                }
                Err(e) => {
                    tracing::warn!(target: "nightcore", task_id, error = %e, "commit-before-review failed; reviewing working tree")
                }
            }
        }
    }

    // Keep the slot leased and the worktree intact: only forget the build session
    // (a new reviewer session correlates to the same task via the FIFO).
    if let Some(sid) = session_id {
        app.state::<std::sync::Arc<SidecarProvider>>().forget(sid);
    }
    tracing::info!(target: "nightcore", task_id, worktree = review_dir.is_worktree, "build complete; entering verification gate");
    apply_and_emit(app, store, task_id, |task| {
        task.status = TaskStatus::Verifying;
        task.summary = result.clone();
        task.cost_usd = cost;
        task.error = None;
    });

    // The deterministic gate battery, in order: the diff-budget park gate
    // (module #5) → the project's own structure-lock manifest checks (#3) → the
    // built-in anti-gaming sweep (#2) → the strictness ratchet (#6) → the task's
    // own verify-command (#1) — all BEFORE the paid reviewer, so an agent can
    // neither verify (nor later merge) out-of-scope work, code that breaks the
    // locked structure, gamed tests, or new laxness, and a broken build never
    // burns a reviewer session. Every gate is opt-in via `.nightcore/` config or
    // the task except the anti-gaming sweep (always-on for worktree builds), so
    // existing projects are unaffected.

    // Diff budget: an out-of-budget diff is a SCOPING decision, not a defect — an
    // auto-fix could only shrink it by deleting work — so a breach parks for
    // human triage (same transition as an exhausted fix budget) and NEVER routes
    // into the auto-fix loop. Worktree builds only: main-mode work has no
    // committed base..HEAD range to measure. The budget is read from the PROJECT
    // root's manifest (`.nightcore/` is gitignored, so no worktree copy exists).
    if review_dir.is_worktree {
        if let Some(project) = app.state::<ProjectStore>().active() {
            if let Some(breach) =
                crate::workflow::diff_budget::evaluate(Path::new(&project.path), &review_dir.path)
            {
                tracing::warn!(target: "nightcore", task_id, "diff budget exceeded; parking for triage");
                apply_and_emit(app, store, task_id, |task| {
                    task.status = TaskStatus::WaitingApproval;
                    task.verified = false;
                    task.error = Some(breach.clone());
                });
                park_for_approval(app, task_id, None);
                return;
            }
        }
    }

    // Structure-lock manifest checks: any failure below routes through the SAME
    // bounded auto-fix loop (or parks once the budget is spent). In worktree mode
    // the manifest is read from the PROJECT root (`.nightcore/` is gitignored, so
    // no worktree copy exists — reading the review dir silently skipped every
    // check) while the checks still RUN in the review dir; main mode is the
    // manifest-root == run-dir case, unchanged.
    let mut lock = match app.state::<ProjectStore>().active() {
        Some(project) if review_dir.is_worktree => {
            crate::gauntlet_project::run_from(Path::new(&project.path), &review_dir.path)
        }
        _ => crate::gauntlet_project::run(&review_dir.path),
    };

    // The three independent read-only measurements — the anti-gaming sweep, the
    // agent-contract budget, and the strictness ratchet — each measure the SAME
    // review dir with NO dependency on one another (finding #2). Sequentially they
    // paid each subprocess's latency in series; instead, once the gauntlet has
    // passed, run the applicable ones CONCURRENTLY on the blocking pool and fold
    // their checks in canonical order. Semantics preserved EXACTLY:
    //   - anti-gaming: always-on for worktree builds (no manifest arms it — it
    //     guards the gate machinery itself); its Bash-history half reads the run's
    //     flight-recorder ledger for the `--no-verify` bypass the diff can't show.
    //   - contract-budget (module #8): a CLAUDE.md/AGENTS.md this run touched that
    //     outgrew the compiled instruction budget; worktree builds only (the
    //     committed diff is what says "touched").
    //   - ratchet: recount the review dir's laxness vs the snapshotted
    //     `.nightcore/ratchet.json` baseline (absent ⇒ nothing; held ⇒ a Passed check).
    // The fold ([`merge_gate`]) reproduces the old stop-at-first byte-for-byte:
    // gates merge in the fixed order [anti-gaming, contract-budget, ratchet], the
    // FIRST failure sets `failed_check`, and every gate after it is dropped — the
    // agent still sees one failure at a time. Only the wall-clock collapses
    // (sum → max); a gate whose result is dropped ran a harmless read-only probe.
    if lock.passed {
        if let Some(project) = app.state::<ProjectStore>().active() {
            let project_root = PathBuf::from(&project.path);
            let review = review_dir.path.clone();
            let ledger = crate::store::ledger::ledger_path(&project_root, task_id);

            // Spawn each applicable gate over a FRESH result (so its append logic is
            // self-contained), collecting handles in the canonical fold order.
            let mut jobs: Vec<tauri::async_runtime::JoinHandle<StructureLockResult>> = Vec::new();
            if review_dir.is_worktree {
                let (r, p, l) = (review.clone(), project_root.clone(), ledger.clone());
                jobs.push(tauri::async_runtime::spawn_blocking(move || {
                    let mut g = StructureLockResult::empty_pass();
                    crate::workflow::anti_gaming::append_anti_gaming_check(
                        &mut g,
                        &r,
                        &p,
                        Some(&l),
                    );
                    g
                }));
                let (r, p) = (review.clone(), project_root.clone());
                jobs.push(tauri::async_runtime::spawn_blocking(move || {
                    let mut g = StructureLockResult::empty_pass();
                    crate::workflow::contract_budget::append_contract_budget_check(&mut g, &r, &p);
                    g
                }));
            }
            let (r, p) = (review.clone(), project_root.clone());
            jobs.push(tauri::async_runtime::spawn_blocking(move || {
                let mut g = StructureLockResult::empty_pass();
                crate::workflow::ratchet::append_ratchet_check(&mut g, &r, &p);
                g
            }));

            // Fold in canonical order with stop-at-first: a gate contributes only
            // while everything before it passed; the rest are discarded.
            for job in jobs {
                if !lock.passed {
                    break;
                }
                match job.await {
                    Ok(gate) => merge_gate(&mut lock, gate),
                    Err(e) => {
                        tracing::warn!(target: "nightcore", task_id, error = %e, "gate measurement task failed to join; skipping")
                    }
                }
            }
        }
    }

    // The verify-command contract (hardening module #1): if every gate above passed
    // and THIS task carries its own machine-checkable done-command, run it in the
    // same review dir as the final deterministic check. A converted Harness task
    // that wires an ESLint plugin, for example, carries `npx eslint .` — proving
    // the wiring actually holds before a paid reviewer ever sees it. A failure
    // folds into the same gate below.
    if lock.passed {
        if let Some(command) = task.verify_command.as_deref() {
            crate::gauntlet_project::append_task_verify_command(
                &mut lock,
                command,
                &review_dir.path,
            );
        }
    }

    apply_and_emit(app, store, task_id, |task| {
        task.structure_lock_result = Some(lock.clone());
    });
    if !lock.passed {
        // Blocked-by-policy park gate: when the battery failed AND the run's
        // flight-recorder ledger shows the harness policy denied writes to
        // protected paths, the failure is a RAILS collision, not a defect — a
        // fix run faces the same denials, so routing into the auto-fix loop
        // only burns the budget before parking anyway. Park for human triage
        // with the denial evidence instead (the diff-budget posture: a scoping
        // decision, never auto-fixed). A PASSING battery with denials changes
        // nothing — the agent completed the work within the rails.
        if let Some(project) = app.state::<ProjectStore>().active() {
            let ledger = crate::store::ledger::ledger_path(Path::new(&project.path), task_id);
            if let Some(message) = crate::store::ledger::blocked_by_policy_message(&ledger) {
                tracing::warn!(target: "nightcore", task_id, "gates failed with harness-policy denials on protected paths; parking for triage");
                apply_and_emit(app, store, task_id, |task| {
                    task.status = TaskStatus::WaitingApproval;
                    task.verified = false;
                    task.error = Some(message.clone());
                });
                park_for_approval(app, task_id, None);
                return;
            }
        }
        gate_structure_lock_failure(app, store, task_id, &lock, &review_dir.path).await;
        return;
    }

    if let Err(e) = dispatch_reviewer(app, task_id, &review_dir.path).await {
        // Couldn't even start the reviewer: verification is inconclusive → park.
        apply_and_emit(app, store, task_id, |task| {
            task.status = TaskStatus::WaitingApproval;
            task.verified = false;
            task.error = Some(format!("could not start reviewer: {e}"));
        });
        park_for_approval(app, task_id, None);
    }
}

/// Fold one independently-measured gate result (finding #2) into the running
/// structure-lock `lock`, reproducing the old sequential stop-at-first EXACTLY.
/// Callers merge gates in the fixed canonical order and stop at the first failure,
/// so when this runs `lock` has passed so far: append the gate's check(s) in order,
/// and on failure flip `passed` + adopt its `failed_check` (only if none is set yet,
/// so the FIRST failing gate owns the reported check). A passing/empty gate leaves
/// `passed`/`failed_check` untouched — byte-identical to having called the gate's
/// `append_*` directly on `lock` in sequence.
fn merge_gate(lock: &mut StructureLockResult, gate: StructureLockResult) {
    lock.checks.extend(gate.checks);
    if !gate.passed {
        lock.passed = false;
        if lock.failed_check.is_none() {
            lock.failed_check = gate.failed_check;
        }
    }
}

/// Route a failed Structure-Lock Gauntlet (feature #3) — or one of the built-in
/// checks appended to the same result (the anti-gaming sweep, the strictness
/// ratchet) — at the verification gate: when the bounded auto-fix budget (shared
/// with the reviewer's `CHANGES_REQUESTED` loop, [`MAX_FIX_ATTEMPTS`]) has room,
/// feed the failing check into a fix-build over the same worktree so the agent
/// self-corrects; once the budget is spent, park the task for human approval
/// (never silently verify). The build
/// session was already forgotten by the caller and the slot is still leased, so a
/// dispatched fix correlates to the same task via the FIFO — exactly like the
/// reviewer's auto-fix path.
async fn gate_structure_lock_failure(
    app: &AppHandle,
    store: &TaskStore,
    task_id: &str,
    lock: &StructureLockResult,
    worktree_dir: &Path,
) {
    let failed = lock.failed_check.clone().unwrap_or_default();
    let attempts = store.get(task_id).map(|t| t.fix_attempts).unwrap_or(0);
    if attempts < MAX_FIX_ATTEMPTS {
        tracing::info!(target: "nightcore", task_id, failed_check = %failed, attempt = attempts + 1, max = MAX_FIX_ATTEMPTS, "structure-lock failed; dispatching auto-fix");
        apply_and_emit(app, store, task_id, |task| {
            task.fix_attempts += 1;
            task.status = TaskStatus::InProgress;
            task.error = None;
        });
        let detail = crate::gauntlet_project::fix_instruction(lock);
        if let Err(e) = dispatch_fix(app, task_id, &detail, worktree_dir).await {
            apply_and_emit(app, store, task_id, |task| {
                task.status = TaskStatus::WaitingApproval;
                task.verified = false;
                task.error = Some(format!("could not start structure-lock fix run: {e}"));
            });
            park_for_approval(app, task_id, None);
        }
    } else {
        tracing::warn!(target: "nightcore", task_id, failed_check = %failed, max = MAX_FIX_ATTEMPTS, "structure-lock failed and auto-fix budget exhausted; parking for approval");
        apply_and_emit(app, store, task_id, |task| {
            task.status = TaskStatus::WaitingApproval;
            task.verified = false;
            task.error = Some(format!(
                "structure-lock gauntlet failed at `{failed}` — fix the harness checks \
                 (auto-fix budget exhausted)"
            ));
        });
        park_for_approval(app, task_id, None);
    }
}

/// A reviewer session completed (M4 §B step 2). Parse the verdict from its result
/// and route: PASS → Done+verified; CHANGES_REQUESTED → bounded auto-fix or park;
/// FAIL/unparseable → park for approval (fail-safe: never silently pass).
pub(crate) async fn handle_review_completed(
    app: &AppHandle,
    store: &TaskStore,
    task_id: &str,
    session_id: Option<u64>,
    result: Option<String>,
    cost: Option<f64>,
) {
    let review_text = result.clone().unwrap_or_default();
    let verdict = parse_verdict(&review_text);
    tracing::info!(target: "nightcore", task_id, session_id = ?session_id, verdict = ?verdict, "verification verdict parsed");

    // The reviewer session is done regardless of verdict; forget it (the slot and
    // worktree stay with the task until a true terminal).
    if let Some(sid) = session_id {
        app.state::<std::sync::Arc<SidecarProvider>>().forget(sid);
    }

    match verdict {
        Verdict::Pass => {
            tracing::info!(target: "nightcore", task_id, "verification passed; task verified and done");
            apply_and_emit(app, store, task_id, |task| {
                task.status = TaskStatus::Done;
                task.verified = true;
                task.review = Some(review_text.clone());
                if let Some(c) = cost {
                    task.cost_usd = Some(c);
                }
                task.error = None;
            });
            // Auto Mode option: commit this task's work HERE — before `finish_run`
            // kicks the next task — so a main-mode `git add -A` on the shared project
            // root captures only this task's changes (the next task hasn't launched
            // yet, and a prior task at concurrency 1 was already committed).
            maybe_auto_commit_on_verified(app, store, task_id).await;
            // NOW it is a true terminal: release slot, clean worktree per policy,
            // record breaker success.
            finish_run(app, task_id, None, Outcome::Succeeded);
        }
        Verdict::ChangesRequested => {
            let attempts = store.get(task_id).map(|t| t.fix_attempts).unwrap_or(0);
            if attempts < MAX_FIX_ATTEMPTS {
                let review_dir = verification_dir(app, task_id);
                let Some(review_dir) = review_dir else {
                    // No dir to fix in: park.
                    park_changes_exhausted(app, store, task_id, &review_text);
                    return;
                };
                let worktree_dir = review_dir.path;
                tracing::info!(target: "nightcore", task_id, attempt = attempts + 1, max = MAX_FIX_ATTEMPTS, "changes requested; dispatching auto-fix");
                apply_and_emit(app, store, task_id, |task| {
                    task.fix_attempts += 1;
                    task.status = TaskStatus::InProgress;
                    task.review = Some(review_text.clone());
                    task.error = None;
                });
                if let Err(e) = dispatch_fix(app, task_id, &review_text, &worktree_dir).await {
                    apply_and_emit(app, store, task_id, |task| {
                        task.status = TaskStatus::WaitingApproval;
                        task.verified = false;
                        task.error = Some(format!("could not start fix run: {e}"));
                    });
                    park_for_approval(app, task_id, None);
                }
            } else {
                park_changes_exhausted(app, store, task_id, &review_text);
            }
        }
        Verdict::Fail => {
            tracing::warn!(target: "nightcore", task_id, "verification failed; parking for approval");
            apply_and_emit(app, store, task_id, |task| {
                task.status = TaskStatus::WaitingApproval;
                task.verified = false;
                task.review = Some(review_text.clone());
            });
            park_for_approval(app, task_id, None);
        }
    }
}

/// Auto Mode option (`auto_commit_on_verified`): commit a just-verified task's work
/// right after it passes review and BEFORE `finish_run` kicks the next task, so its
/// changes land in their own commit (reusing the manual `commit_task` path — a
/// `claude -p` conventional message, the `TaskLease` single-flight, the `committed`
/// flag + `nc:task` emit). Best-effort: any failure (including a benign "nothing to
/// commit") is logged and never blocks the terminal path.
///
/// Safety: a main-mode task commits the SHARED project root via `git add -A`, which
/// only yields a clean per-task commit when the loop runs one task at a time — with
/// concurrent runs the root also holds sibling tasks' uncommitted edits that can't
/// be separated, so it's gated on `max_concurrency == 1`. A worktree-mode task
/// already committed its work to `nc/<id>` pre-review (its finalize action is merge,
/// not commit), so there is nothing to auto-commit and it is skipped.
async fn maybe_auto_commit_on_verified(app: &AppHandle, store: &TaskStore, task_id: &str) {
    use crate::settings::SettingsStore;
    let (auto_commit_on_verified, max_concurrency) = app
        .state::<SettingsStore>()
        .with_settings(|s| (s.auto_commit_on_verified, s.max_concurrency));
    if !auto_commit_on_verified {
        return;
    }
    let Some(task) = store.get(task_id) else {
        return;
    };
    if task.run_mode.is_worktree() {
        return;
    }
    if max_concurrency > 1 {
        tracing::info!(target: "nightcore", task_id, max_concurrency, "auto-commit on verified skipped: main mode needs concurrency 1");
        return;
    }
    // Runs the blocking git + `claude -p` body off the async reader task; awaited so
    // the commit lands before `finish_run` launches the next task.
    let app_c = app.clone();
    let id_c = task_id.to_string();
    match tauri::async_runtime::spawn_blocking(move || {
        crate::workflow::merge::commit_task_blocking(&app_c, &id_c)
    })
    .await
    {
        Ok(Ok(())) => {
            tracing::info!(target: "nightcore", task_id, "auto-committed task on verified")
        }
        Ok(Err(e)) => {
            tracing::info!(target: "nightcore", task_id, reason = %e, "auto-commit on verified skipped")
        }
        Err(e) => {
            tracing::warn!(target: "nightcore", task_id, error = %e, "auto-commit on verified failed to run")
        }
    }
}

/// Park a task whose auto-fix budget is exhausted: WaitingApproval, keep the
/// review with an exhaustion note appended so the UI surfaces it (M4 §E).
fn park_changes_exhausted(app: &AppHandle, store: &TaskStore, task_id: &str, review_text: &str) {
    tracing::warn!(target: "nightcore", task_id, max = MAX_FIX_ATTEMPTS, "auto-fix budget exhausted; parking for approval");
    let note = format!("{review_text}\n\n[auto-fix budget exhausted]");
    apply_and_emit(app, store, task_id, |task| {
        task.status = TaskStatus::WaitingApproval;
        task.verified = false;
        task.review = Some(note.clone());
    });
    park_for_approval(app, task_id, None);
}

/// The directory the verification gate reviews in, plus whether it is an isolated
/// worktree (M4.6 §A). `worktree` mode reviews the build's `nc/<taskId>` worktree
/// (commit-then-diff); `main` mode reviews the project ROOT (working tree vs HEAD).
/// `None` ⇒ no active project, nothing to review.
struct ReviewDir {
    path: PathBuf,
    is_worktree: bool,
}

/// Resolve the verification review dir for a task (M4.6 §A). A worktree-mode task
/// reviews its `nc/<taskId>` worktree when it exists on disk; a main-mode task
/// reviews the project root (working tree vs HEAD). `None` ⇒ no active project.
fn verification_dir(app: &AppHandle, task_id: &str) -> Option<ReviewDir> {
    let project = app.state::<ProjectStore>().active()?;
    let project_path = PathBuf::from(&project.path);
    let run_mode = app
        .state::<TaskStore>()
        .get(task_id)
        .map(|t| t.run_mode)
        .unwrap_or_default();

    if run_mode.is_worktree() {
        let dir = worktree::worktree_path(&project_path, task_id);
        // No worktree on disk (cleaned up / never allocated) ⇒ nothing to diff.
        return dir.exists().then_some(ReviewDir {
            path: dir,
            is_worktree: true,
        });
    }
    // Main mode: review the project root against its current HEAD.
    Some(ReviewDir {
        path: project_path,
        is_worktree: false,
    })
}

/// The commit message for the auto-commit-before-review (M4.6 §A): the task's
/// title, or a fallback when blank. Kept distinct from `merge::commit_message` so
/// the auto-loop commit reads naturally in the branch history.
fn build_commit_message(task: &Task) -> String {
    let title = task.title.trim();
    if title.is_empty() {
        format!("nightcore: task {}", task.id)
    } else {
        title.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{build_commit_message, merge_gate};
    use crate::store::types::{StepStatus, StructureLockCheck, StructureLockResult};
    use crate::task::Task;

    fn check(name: &str, status: StepStatus) -> StructureLockCheck {
        StructureLockCheck {
            name: name.to_string(),
            kind: name.to_string(),
            command: name.to_string(),
            status,
            exit_code: None,
            output: None,
        }
    }

    /// A gate measured over a fresh result: a single failing check (mirrors how the
    /// `append_*` gates flip their own fresh result on failure).
    fn failing_gate(name: &str) -> StructureLockResult {
        StructureLockResult {
            passed: false,
            checks: vec![check(name, StepStatus::Failed)],
            failed_check: Some(name.to_string()),
        }
    }

    /// A gate that appended a visible Passed check but did not fail.
    fn passing_gate(name: &str) -> StructureLockResult {
        StructureLockResult {
            passed: true,
            checks: vec![check(name, StepStatus::Passed)],
            failed_check: None,
        }
    }

    #[test]
    fn merge_gate_folds_passing_gates_in_order() {
        // gauntlet already passed → merge two passing gates; order + pass preserved.
        let mut lock = StructureLockResult::empty_pass();
        lock.checks.push(check("gauntlet", StepStatus::Passed));
        merge_gate(&mut lock, passing_gate("agent-contract-budget"));
        merge_gate(&mut lock, passing_gate("strictness-ratchet"));
        assert!(lock.passed);
        assert_eq!(lock.failed_check, None);
        let names: Vec<_> = lock.checks.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            ["gauntlet", "agent-contract-budget", "strictness-ratchet"],
            "checks stay in canonical fold order"
        );
    }

    #[test]
    fn merge_gate_first_failure_owns_the_failed_check_and_drops_the_rest() {
        // The caller stops folding after the first failure (stop-at-first): the
        // dropped gates are never merged, so only the first failing check appears and
        // it owns `failed_check` — byte-identical to the old sequential guard.
        let mut lock = StructureLockResult::empty_pass();
        merge_gate(&mut lock, failing_gate("anti-gaming")); // first failure
        assert!(!lock.passed);
        assert_eq!(lock.failed_check.as_deref(), Some("anti-gaming"));
        // Caller would `break` here; assert a later gate never overrides the owner
        // even if (defensively) merged.
        merge_gate(&mut lock, failing_gate("strictness-ratchet"));
        assert_eq!(
            lock.failed_check.as_deref(),
            Some("anti-gaming"),
            "the first failing gate keeps ownership of failed_check"
        );
    }

    #[test]
    fn build_commit_message_uses_title_or_falls_back() {
        let mut task = Task::new("Implement the parser".into(), String::new());
        assert_eq!(build_commit_message(&task), "Implement the parser");
        task.title = "  ".into();
        assert!(
            build_commit_message(&task).contains(&task.id),
            "blank title falls back to id"
        );
    }
}
