//! The M4 verification gate state machine: a completed build commits its work and
//! dispatches an independent reviewer; the reviewer's verdict routes to done,
//! bounded auto-fix, or a park-for-approval. Fail-safe throughout — an unparseable
//! verdict or a crashed reviewer never silently passes.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::gauntlet_project::StructureLockResult;
use crate::kind;
use crate::orchestration::coordinator::Orchestrator;
use crate::orchestration::provider::Provider;
use crate::orchestration::worktree;
use crate::project::ProjectStore;
use crate::store::TaskStore;
use crate::task::{ProposedSubtask, SubtaskStatus, Task, TaskKind, TaskStatus};

use super::commands::{resolve_context_pack, resolve_mcp_servers, resolve_permission_mode};
use super::{apply_and_emit, finish_run, park_for_approval, Outcome};

/// The bounded auto-fix budget for the verification gate (M4 §B). On a
/// `CHANGES_REQUESTED` verdict the core dispatches up to this many fix-build
/// sessions before parking the task for human approval.
pub const MAX_FIX_ATTEMPTS: u32 = 2;

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
        app.state::<Orchestrator>().provider.forget(sid);
    }
    tracing::info!(target: "nightcore", task_id, worktree = review_dir.is_worktree, "build complete; entering verification gate");
    apply_and_emit(app, store, task_id, |task| {
        task.status = TaskStatus::Verifying;
        task.summary = result.clone();
        task.cost_usd = cost;
        task.error = None;
    });

    // Structure-Lock Gauntlet (feature #3): run the TARGET project's own generated
    // harness checks (custom lint-plugin / dependency-cruiser / coverage) as a
    // DETERMINISTIC gate BEFORE the paid reviewer — an agent must not be able to
    // verify (or later merge) code that breaks the locked structure, and a broken
    // build should never burn a reviewer session. Absent `.nightcore/harness.json`
    // ⇒ no checks ⇒ pass, so existing projects are unaffected. On failure we either
    // feed the failing check into the existing bounded auto-fix loop, or park.
    let lock = crate::gauntlet_project::run(&review_dir.path);
    apply_and_emit(app, store, task_id, |task| {
        task.structure_lock_result = Some(lock.clone());
    });
    if !lock.passed {
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

/// Route a failed Structure-Lock Gauntlet (feature #3) at the verification gate:
/// when the bounded auto-fix budget (shared with the reviewer's `CHANGES_REQUESTED`
/// loop, [`MAX_FIX_ATTEMPTS`]) has room, feed the failing harness check into a
/// fix-build over the same worktree so the agent self-corrects; once the budget is
/// spent, park the task for human approval (never silently verify). The build
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
        app.state::<Orchestrator>().provider.forget(sid);
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

/// The verdict an independent reviewer returned. Parsed from its final message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    ChangesRequested,
    Fail,
}

/// Parse the machine-readable verdict from a reviewer's result text. The reviewer
/// is instructed to end with a single `VERDICT: PASS|CHANGES_REQUESTED|FAIL` line;
/// we grep for the last match (the final verdict wins). No token ⇒ `Fail`
/// (fail-safe: never silently pass).
pub fn parse_verdict(text: &str) -> Verdict {
    let mut found: Option<Verdict> = None;
    for line in text.lines() {
        if let Some(rest) = line.split_once("VERDICT:") {
            let token = rest.1.trim();
            let verdict = if token.starts_with("PASS") {
                Some(Verdict::Pass)
            } else if token.starts_with("CHANGES_REQUESTED") {
                Some(Verdict::ChangesRequested)
            } else if token.starts_with("FAIL") {
                Some(Verdict::Fail)
            } else {
                None
            };
            if let Some(v) = verdict {
                found = Some(v); // last match wins
            }
        }
    }
    found.unwrap_or(Verdict::Fail)
}

/// Merge a decompose re-run's freshly-parsed proposals with the task's existing
/// ones, PRESERVING any already-`Converted` proposal (and its `linked_task_id`) so a
/// re-run never orphans a converted child task or loses its bookkeeping. The kept
/// converted proposals come first (original order), then the fresh proposals. On a
/// first run `existing` is empty, so the result is just `fresh`.
pub fn merge_proposed_subtasks(
    existing: &[ProposedSubtask],
    fresh: Vec<ProposedSubtask>,
) -> Vec<ProposedSubtask> {
    let mut merged: Vec<ProposedSubtask> = existing
        .iter()
        .filter(|s| s.status == SubtaskStatus::Converted)
        .cloned()
        .collect();
    merged.extend(fresh);
    merged
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

/// Dispatch the read-only reviewer session over the build's worktree (M4 §B). The
/// reviewer correlates to the same task via the FIFO; its agent identity is the
/// engine's `review` preset, its per-run instructions (which diff, the base
/// branch, the verdict format) are this core-owned prompt.
pub(crate) async fn dispatch_reviewer_for(
    app: &AppHandle,
    task_id: &str,
    worktree_dir: &Path,
) -> Result<(), String> {
    dispatch_reviewer(app, task_id, worktree_dir).await
}

async fn dispatch_reviewer(
    app: &AppHandle,
    task_id: &str,
    worktree_dir: &Path,
) -> Result<(), String> {
    let orch = app.state::<Orchestrator>();
    let store = app.state::<TaskStore>();
    let task = store.get(task_id).ok_or("task vanished before review")?;
    // A worktree-mode run has a `nc/<taskId>` branch with a real `base...HEAD`
    // range to supplement the working-tree diff; a main-mode run reviews the
    // working tree vs HEAD only (no branch to range against).
    let has_branch = task.run_mode.is_worktree();
    let base = reviewer_base_branch(app);
    tracing::info!(target: "nightcore", task_id, base = %base, worktree = has_branch, "dispatching reviewer");
    let prompt = reviewer_prompt(&task, &base, has_branch);
    // Reviewer model: V4 reviewer-model policy is deferred to M5; use the task's
    // model (None ⇒ core default), so the reviewer is a peer of the builder.
    orch.provider
        .start_session(
            task_id,
            prompt,
            task.model.clone(),
            // The reviewer keeps its own policy (M4.7 §E): it inherits the task's
            // effort like the builder, a peer of the build run.
            task.effort.clone(),
            Some(worktree_dir.to_path_buf()),
            // The review preset's `dontAsk` default applies (no explicit override).
            None,
            TaskKind::Review.as_wire(),
            // Image attachments ride the MAIN build session only; the reviewer judges
            // the resulting diff, not the original images.
            Vec::new(),
            // SDK-guardrails: a reviewer is a fresh, peer sub-run — it inherits the
            // task's ceilings but is NEVER resumed (it has its own prompt/identity).
            // It runs in the same project, so it injects the same enabled MCP servers.
            crate::orchestration::provider::Guardrails {
                max_turns: task.max_turns,
                max_budget_usd: task.max_budget_usd,
                resume_session_id: None,
                mcp_servers: resolve_mcp_servers(app),
                // Lock (feature #4): the reviewer judges against the project's own
                // Constitution, so it starts knowing the rules it's enforcing.
                append_context_pack: resolve_context_pack(app),
            },
        )
        .await
}

/// Dispatch a fix-build session for a `CHANGES_REQUESTED` verdict (M4 §B). Same
/// worktree as the build, `kind=build`, prompt = the original task prompt plus the
/// reviewer's change list. Its completion re-enters the build-completed path.
async fn dispatch_fix(
    app: &AppHandle,
    task_id: &str,
    review_text: &str,
    worktree_dir: &Path,
) -> Result<(), String> {
    let orch = app.state::<Orchestrator>();
    let store = app.state::<TaskStore>();
    let task = store.get(task_id).ok_or("task vanished before fix")?;
    let prompt = format!(
        "{}\n\n--- A reviewer requested changes ---\n{}",
        task.prompt(),
        review_text
    );
    let permission_mode = resolve_permission_mode(app, task.permission_mode.as_deref());
    orch.provider
        .start_session(
            task_id,
            prompt,
            task.model.clone(),
            task.effort.clone(),
            Some(worktree_dir.to_path_buf()),
            permission_mode,
            TaskKind::Build.as_wire(),
            // Image attachments ride the MAIN build session only; the fix-build works
            // from the reviewer's change list over the existing diff.
            Vec::new(),
            // SDK-guardrails: a fix-build is a fresh sub-run over the same worktree
            // with a new prompt — inherit the ceilings but never resume. Injects the
            // same project's enabled MCP servers.
            crate::orchestration::provider::Guardrails {
                max_turns: task.max_turns,
                max_budget_usd: task.max_budget_usd,
                resume_session_id: None,
                mcp_servers: resolve_mcp_servers(app),
                // Lock (feature #4): a fix-build still edits the project, so it gets
                // the same on-rails Constitution as the original build.
                append_context_pack: resolve_context_pack(app),
            },
        )
        .await
}

/// The base branch the reviewer diffs against — the active project's base (the
/// same base `merge.rs` merges into). Falls back to `main` without a project.
fn reviewer_base_branch(app: &AppHandle) -> String {
    match app.state::<ProjectStore>().active() {
        Some(project) => worktree::base_branch(&PathBuf::from(&project.path)),
        None => worktree::DEFAULT_BASE_BRANCH.to_string(),
    }
}

/// The per-run reviewer prompt (core-owned). Makes the WORKING TREE authoritative,
/// not just a committed range (M4.6 §A): the build's edits may be uncommitted, so a
/// reviewer that judges only `base...HEAD` would see an empty range and wrongly
/// conclude "not implemented" (the dogfood bug). The reviewer inspects the union of
/// working-tree + staged + untracked + (when a branch exists) the committed range,
/// and must never conclude "no changes" from an empty `base...HEAD` alone.
fn reviewer_prompt(task: &Task, base: &str, has_branch: bool) -> String {
    // The committed-range step only makes sense when this run has its own branch
    // (worktree mode). In main mode there is no branch — the working tree vs HEAD
    // IS the change set.
    let range_step = if has_branch {
        format!(
            "5. `git diff {base}...HEAD` — commits on this branch since `{base}` \
             (supplementary; may be empty if the work is staged/uncommitted — that \
             alone NEVER means \"no changes\").\n"
        )
    } else {
        String::new()
    };
    let scope = if has_branch {
        "this worktree branch"
    } else {
        "the project working tree"
    };

    format!(
        "Review the changes in {scope}, which implement the task below.\n\n\
         Task:\n{task_prompt}\n\n\
         The change may be UNCOMMITTED. Treat the WORKING TREE as authoritative — \
         inspect the UNION of all of these and judge them together:\n\
         1. `git status --porcelain` — every staged, unstaged, and untracked path.\n\
         2. `git diff` — unstaged changes to tracked files.\n\
         3. `git diff --cached` — staged changes.\n\
         4. Read the full contents of any UNTRACKED files (they won't show in \
         `git diff`).\n\
         {range_step}\n\
         Judge correctness and completeness against the task over that union. NEVER \
         conclude \"nothing was implemented\" from an empty `{base}...HEAD` range \
         alone — the work is often present as uncommitted working-tree edits and/or \
         untracked files.\n\n\
         End your final message with a single line that is exactly one of:\n\
         VERDICT: PASS\n\
         VERDICT: CHANGES_REQUESTED\n\
         VERDICT: FAIL\n\n\
         Put your rationale above that line. For CHANGES_REQUESTED, include a \
         numbered list of the changes needed.",
        scope = scope,
        task_prompt = task.prompt(),
        range_step = range_step,
        base = base,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        build_commit_message, merge_proposed_subtasks, parse_verdict, reviewer_prompt, Verdict,
    };
    use crate::task::{ProposedSubtask, RunMode, SubtaskStatus, Task};

    #[test]
    fn reviewer_prompt_is_working_tree_authoritative() {
        // M4.6 §A: the prompt must make the WORKING TREE authoritative, instruct the
        // standard four reads, and warn against concluding "no changes" from an
        // empty base..HEAD range alone (the dogfood bug).
        let task = Task::new("Add a README line".into(), String::new());
        let prompt = reviewer_prompt(&task, "main", true);

        assert!(
            prompt.contains("git status --porcelain"),
            "lists working-tree status"
        );
        assert!(
            prompt.contains("git diff --cached"),
            "inspects staged changes"
        );
        assert!(
            prompt.contains("UNTRACKED"),
            "reads untracked file contents"
        );
        assert!(
            prompt.contains("WORKING TREE"),
            "frames the working tree as authoritative"
        );
        assert!(
            prompt.contains("NEVER") && prompt.contains("main...HEAD"),
            "warns against concluding from an empty range alone"
        );
        // Worktree mode includes the supplementary committed-range step.
        assert!(
            prompt.contains("git diff main...HEAD"),
            "worktree mode adds the range step"
        );
        assert!(
            prompt.contains("VERDICT: PASS"),
            "keeps the machine-readable verdict contract"
        );
    }

    #[test]
    fn reviewer_prompt_main_mode_omits_the_committed_range_step() {
        // A main-mode task has no branch; the prompt diffs the working tree vs HEAD
        // and must NOT instruct a (meaningless) committed-range diff.
        let task = Task::new("Edit on main".into(), String::new());
        let prompt = reviewer_prompt(&task, "main", false);

        assert!(
            prompt.contains("project working tree"),
            "scopes to the project tree"
        );
        assert!(
            prompt.contains("git status --porcelain"),
            "still inspects the working tree"
        );
        assert!(
            !prompt.contains("git diff main...HEAD"),
            "main mode omits the committed-range step (no branch to range)"
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

    #[test]
    fn run_mode_is_worktree_predicate() {
        assert!(!RunMode::Main.is_worktree());
        assert!(RunMode::Worktree.is_worktree());
    }

    #[test]
    fn verdict_parses_each_token() {
        assert_eq!(parse_verdict("ok\nVERDICT: PASS"), Verdict::Pass);
        assert_eq!(
            parse_verdict("VERDICT: CHANGES_REQUESTED"),
            Verdict::ChangesRequested
        );
        assert_eq!(parse_verdict("VERDICT: FAIL"), Verdict::Fail);
    }

    #[test]
    fn verdict_last_match_wins() {
        // A reviewer that mentions an earlier verdict then concludes with another:
        // the final line is authoritative.
        let text = "first I thought VERDICT: FAIL\nbut actually\nVERDICT: PASS";
        assert_eq!(parse_verdict(text), Verdict::Pass);
    }

    #[test]
    fn verdict_tolerates_trailing_rationale_on_the_line() {
        assert_eq!(parse_verdict("VERDICT: PASS — looks good"), Verdict::Pass);
    }

    #[test]
    fn no_verdict_token_fails_safe() {
        // Fail-safe: an unparseable / token-less review never silently passes.
        assert_eq!(
            parse_verdict("I forgot to include a verdict line"),
            Verdict::Fail
        );
        assert_eq!(parse_verdict(""), Verdict::Fail);
        assert_eq!(parse_verdict("VERDICT: MAYBE"), Verdict::Fail);
    }

    #[test]
    fn proposed_subtask_from_wire_mints_core_owned_fields() {
        use serde_json::json;
        // A valid wire `{title, prompt}` object is minted into a ProposedSubtask: the
        // title/prompt come from the wire, but the id (fresh uuid), Open status, and
        // empty link are core-owned — never taken from the model's output.
        let a = ProposedSubtask::from_wire(&json!({
            "title": "Add the schema",
            "prompt": "Create the table"
        }))
        .expect("a valid item is minted");
        let b = ProposedSubtask::from_wire(&json!({
            "title": "Wire the UI",
            "prompt": "Build the form"
        }))
        .expect("a valid item is minted");
        assert_eq!(a.title, "Add the schema");
        assert_eq!(a.prompt, "Create the table");
        assert_eq!(a.status, SubtaskStatus::Open);
        assert!(a.linked_task_id.is_none());
        assert!(
            !a.id.is_empty() && a.id != b.id,
            "each item gets a fresh, distinct uuid"
        );

        // A blank/whitespace-only title is dropped (None ⇒ filtered out of the array).
        assert!(
            ProposedSubtask::from_wire(&json!({"title": "  ", "prompt": "skip me"})).is_none(),
            "blank title is dropped"
        );
        // A missing title is dropped (a prompt alone is not a proposal).
        assert!(
            ProposedSubtask::from_wire(&json!({"prompt": "no title"})).is_none(),
            "missing title is dropped"
        );
        // A missing prompt defaults to empty; the item still mints.
        let c = ProposedSubtask::from_wire(&json!({"title": "only a title"}))
            .expect("a title alone still mints");
        assert_eq!(c.prompt, "", "missing prompt defaults to empty");
    }

    #[test]
    fn merge_preserves_converted_proposals_across_a_rerun() {
        // A re-run of a decompose task must keep already-converted proposals (so
        // their children aren't orphaned) and append the freshly-parsed ones.
        let existing = vec![
            ProposedSubtask {
                id: "kept".into(),
                title: "Already shipped".into(),
                prompt: "x".into(),
                status: SubtaskStatus::Converted,
                linked_task_id: Some("child-1".into()),
            },
            ProposedSubtask {
                id: "stale-open".into(),
                title: "Not yet converted".into(),
                prompt: "y".into(),
                status: SubtaskStatus::Open,
                linked_task_id: None,
            },
        ];
        // The fresh proposals are what the reader builds from the wire array (each
        // minted Open + unlinked).
        let fresh = vec![ProposedSubtask {
            id: "fresh-1".into(),
            title: "new one".into(),
            prompt: "z".into(),
            status: SubtaskStatus::Open,
            linked_task_id: None,
        }];
        let merged = merge_proposed_subtasks(&existing, fresh);
        // The converted proposal survives (with its link); the stale OPEN one is
        // dropped in favor of the fresh proposal.
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].id, "kept");
        assert_eq!(merged[0].linked_task_id.as_deref(), Some("child-1"));
        assert_eq!(merged[1].title, "new one");
        assert_eq!(merged[1].status, SubtaskStatus::Open);
    }

    #[test]
    fn merge_on_a_first_run_is_just_the_fresh_proposals() {
        let fresh = vec![ProposedSubtask {
            id: "a".into(),
            title: "first".into(),
            prompt: "p".into(),
            status: SubtaskStatus::Open,
            linked_task_id: None,
        }];
        let merged = merge_proposed_subtasks(&[], fresh.clone());
        assert_eq!(merged, fresh);
    }
}
