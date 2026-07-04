//! Reviewer/fix session dispatch and the core-owned prompts (M4 §B). Starts the
//! read-only reviewer over the build's worktree, and the bounded fix-build for a
//! `CHANGES_REQUESTED` verdict; owns the auto-fix budget [`MAX_FIX_ATTEMPTS`].

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::gauntlet::GauntletResult;
use crate::project::ProjectStore;
use crate::provider::{Provider, SidecarProvider};
use crate::store::types::StepStatus;
use crate::store::TaskStore;
use crate::task::{Task, TaskKind};
use crate::worktree;

use crate::sidecar::commands::{
    resolve_context_pack, resolve_harness_policy, resolve_ledger_path, resolve_mcp_servers,
    resolve_permission_mode, resolve_sandbox_writes,
};

/// The bounded auto-fix budget for the verification gate (M4 §B). On a
/// `CHANGES_REQUESTED` verdict the core dispatches up to this many fix-build
/// sessions before parking the task for human approval.
pub const MAX_FIX_ATTEMPTS: u32 = 2;

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

pub(crate) async fn dispatch_reviewer(
    app: &AppHandle,
    task_id: &str,
    worktree_dir: &Path,
) -> Result<(), String> {
    let provider = app.state::<std::sync::Arc<SidecarProvider>>();
    let store = app.state::<TaskStore>();
    let task = store.get(task_id).ok_or("task vanished before review")?;
    // A worktree-mode run has a `nc/<taskId>` branch with a real `base...HEAD`
    // range to supplement the working-tree diff; a main-mode run reviews the
    // working tree vs HEAD only (no branch to range against).
    let has_branch = task.run_mode.is_worktree();
    let base = reviewer_base_branch(app);
    tracing::info!(target: "nightcore", task_id, base = %base, worktree = has_branch, "dispatching reviewer");
    // Run the project's real typecheck/lint/test in the review dir and hand the
    // reviewer the results as GROUND TRUTH (finding: the `dontAsk` reviewer is
    // refused when it tries to run `bun run test` itself, so it fails verification
    // instead of judging it). Best-effort — a gauntlet that can't run still yields
    // a section, and the reviewer proceeds regardless.
    let checks_section = reviewer_check_results(worktree_dir).await;
    let prompt = reviewer_prompt(&task, &base, has_branch, &checks_section);
    // Reviewer model: V4 reviewer-model policy is deferred to M5; use the task's
    // model (None ⇒ core default), so the reviewer is a peer of the builder.
    provider
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
            crate::provider::Guardrails {
                max_turns: task.max_turns,
                max_budget_usd: task.max_budget_usd,
                resume_session_id: None,
                mcp_servers: resolve_mcp_servers(app),
                // Lock (feature #4): the reviewer judges against the project's own
                // Constitution, so it starts knowing the rules it's enforcing.
                append_context_pack: resolve_context_pack(app),
                // Module #3: the reviewer session runs under the same protected-path
                // rules as the build (it can run tools too).
                harness_policy: resolve_harness_policy(app),
                // Module #5: the reviewer appends to the task's SHARED ledger
                // (its own session-start/end markers segment it from the build).
                ledger_path: resolve_ledger_path(app, task_id),
                // Module #15: the reviewer is OS-write-contained like the build.
                sandbox_writes: resolve_sandbox_writes(app),
            },
        )
        .await
}

/// Dispatch a fix-build session for a `CHANGES_REQUESTED` verdict (M4 §B). Same
/// worktree as the build, `kind=build`, prompt = the original task prompt plus the
/// reviewer's change list. Its completion re-enters the build-completed path.
pub(crate) async fn dispatch_fix(
    app: &AppHandle,
    task_id: &str,
    review_text: &str,
    worktree_dir: &Path,
) -> Result<(), String> {
    let store = app.state::<TaskStore>();
    let task = store.get(task_id).ok_or("task vanished before fix")?;
    let prompt = format!(
        "{}\n\n--- A reviewer requested changes ---\n{}",
        task.prompt(),
        review_text
    );
    dispatch_build_fix(app, task_id, prompt, worktree_dir).await
}

/// Dispatch a fix-build session for GitHub PR review comments (PR arc, phase 3).
/// Identical to [`dispatch_fix`] except the caller supplies a READY-BUILT, fenced
/// prompt (each UNTRUSTED comment body already wrapped by `untrusted_block`) that
/// is used verbatim — the composition lives in `workflow::pr_comments`, not here.
pub(crate) async fn dispatch_pr_comment_fix(
    app: &AppHandle,
    task_id: &str,
    prompt: &str,
    worktree_dir: &Path,
) -> Result<(), String> {
    dispatch_build_fix(app, task_id, prompt.to_string(), worktree_dir).await
}

/// The shared body of the two fix-build dispatchers: start a `kind=build` session
/// over `worktree_dir` with the given ready-built `prompt` and the task's
/// ceilings/policy. [`dispatch_fix`] (a reviewer verdict) and
/// [`dispatch_pr_comment_fix`] (GitHub review comments) differ ONLY in how they
/// compose the prompt; everything below is identical for both.
async fn dispatch_build_fix(
    app: &AppHandle,
    task_id: &str,
    prompt: String,
    worktree_dir: &Path,
) -> Result<(), String> {
    let provider = app.state::<std::sync::Arc<SidecarProvider>>();
    let store = app.state::<TaskStore>();
    let task = store.get(task_id).ok_or("task vanished before fix")?;
    let permission_mode = resolve_permission_mode(app, task.permission_mode.as_deref());
    provider
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
            crate::provider::Guardrails {
                max_turns: task.max_turns,
                max_budget_usd: task.max_budget_usd,
                resume_session_id: None,
                mcp_servers: resolve_mcp_servers(app),
                // Lock (feature #4): a fix-build still edits the project, so it gets
                // the same on-rails Constitution as the original build.
                append_context_pack: resolve_context_pack(app),
                // Module #3: a fix-build mutates the project under the same
                // protected-path rules as the original build.
                harness_policy: resolve_harness_policy(app),
                // Module #5: a fix-build appends to the task's SHARED ledger, so
                // policy denials during the fix loop reach the same park gate.
                ledger_path: resolve_ledger_path(app, task_id),
                // Module #15: a fix-build is OS-write-contained like the build.
                sandbox_writes: resolve_sandbox_writes(app),
            },
        )
        .await
}

/// The prompt note used when the readiness gauntlet could not be run (its blocking
/// task failed to join). The reviewer still runs — verification must never hang on
/// the gauntlet — it just judges the diff without the ground-truth check results.
const CHECKS_UNAVAILABLE: &str =
    "Automated project checks: unavailable (the check runner could not be launched). \
     Judge the diff on its own, and be conservative about correctness.";

/// Run the readiness gauntlet (the project's real typecheck/lint/test, auto-detected
/// by `crate::gauntlet`) over the review dir and render its per-step outcomes as a
/// ground-truth block for the reviewer prompt. The gauntlet body spawns subprocesses
/// and BLOCKS, so it runs on the blocking pool; awaited so the results are in hand
/// before the prompt is built. Best-effort: a join failure yields
/// [`CHECKS_UNAVAILABLE`] rather than aborting the reviewer dispatch — a broken
/// gauntlet must never wedge the verification gate.
async fn reviewer_check_results(worktree_dir: &Path) -> String {
    let dir = worktree_dir.to_path_buf();
    match tauri::async_runtime::spawn_blocking(move || {
        // Deps first: a worktree allocated before submit-time provisioning existed
        // (or whose install failed transiently) would red-fail typecheck on
        // unresolvable package-local deps — a spurious ChangesRequested that burns
        // a paid fix cycle. Cheap when already provisioned (a frozen install
        // no-ops), and best-effort like the gauntlet itself.
        if let Err(e) = crate::worktree::provision_deps(&dir) {
            tracing::warn!(target: "nightcore", error = %e, "worktree dep provisioning failed before review gauntlet; running checks anyway");
        }
        crate::gauntlet::run(&dir)
    })
    .await
    {
        Ok(result) => format_check_results(&result),
        Err(e) => {
            tracing::warn!(target: "nightcore", error = %e, "readiness gauntlet failed to run for reviewer; proceeding without check results");
            CHECKS_UNAVAILABLE.to_string()
        }
    }
}

/// Render the readiness gauntlet's per-step outcomes as a ground-truth block for the
/// reviewer prompt. Empty detection ⇒ an explicit "none detected" note (so the
/// reviewer knows the absence is real, not a runner failure); otherwise a bulleted
/// pass/fail/skip list, with a failing step's truncated output attached as evidence.
/// The header frames the results as authoritative and forbids the reviewer from
/// re-running the commands (it is read-only and the attempt would be denied).
fn format_check_results(result: &GauntletResult) -> String {
    if result.steps.is_empty() {
        return "Automated project checks: none detected in this worktree (no \
                package.json typecheck/lint/test scripts and no Cargo project). Judge \
                the diff on its own."
            .to_string();
    }

    let mut lines = String::new();
    for step in &result.steps {
        let status = match step.status {
            StepStatus::Passed => "PASSED".to_string(),
            StepStatus::Failed => match step.exit_code {
                Some(code) => format!("FAILED (exit {code})"),
                None => "FAILED".to_string(),
            },
            StepStatus::Skipped => "SKIPPED (an earlier check failed)".to_string(),
        };
        lines.push_str(&format!(
            "- {} (`{}`): {}\n",
            step.name, step.command, status
        ));
        if let Some(output) = &step.output {
            // Indent the failure tail so it reads as evidence attached to its step.
            for line in output.lines() {
                lines.push_str("    ");
                lines.push_str(line);
                lines.push('\n');
            }
        }
    }

    format!(
        "The project's automated checks have ALREADY been run for you in this \
         worktree — treat the results below as GROUND TRUTH. You are READ-ONLY and \
         cannot run them yourself; do NOT attempt to (typecheck/lint/test calls would \
         be denied). A genuine check FAILURE below is strong evidence the change is \
         incomplete or broken; weigh it against the diff before deciding.\n\n\
         Check results:\n{}",
        lines.trim_end(),
    )
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
fn reviewer_prompt(task: &Task, base: &str, has_branch: bool, checks_section: &str) -> String {
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
         {checks_section}\n\n\
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
        checks_section = checks_section,
        range_step = range_step,
        base = base,
    )
}

#[cfg(test)]
mod tests {
    use super::{format_check_results, reviewer_prompt, CHECKS_UNAVAILABLE};
    use crate::gauntlet::{GauntletResult, GauntletStep};
    use crate::store::types::StepStatus;
    use crate::task::Task;

    fn step(
        name: &str,
        command: &str,
        status: StepStatus,
        exit: Option<i32>,
        out: Option<&str>,
    ) -> GauntletStep {
        GauntletStep {
            name: name.to_string(),
            command: command.to_string(),
            status,
            exit_code: exit,
            output: out.map(str::to_string),
        }
    }

    #[test]
    fn reviewer_prompt_is_working_tree_authoritative() {
        // M4.6 §A: the prompt must make the WORKING TREE authoritative, instruct the
        // standard four reads, and warn against concluding "no changes" from an
        // empty base..HEAD range alone (the dogfood bug).
        let task = Task::new("Add a README line".into(), String::new());
        let prompt = reviewer_prompt(
            &task,
            "main",
            true,
            "Automated project checks: none detected.",
        );

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
        let prompt = reviewer_prompt(
            &task,
            "main",
            false,
            "Automated project checks: none detected.",
        );

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
    fn reviewer_prompt_embeds_the_check_results_section() {
        // The gauntlet's ground-truth results must reach the reviewer prompt verbatim,
        // and the machine-readable verdict contract must survive the injection.
        let task = Task::new("Add a feature".into(), String::new());
        let checks = format_check_results(&GauntletResult {
            passed: false,
            steps: vec![
                step(
                    "typecheck",
                    "bun run typecheck",
                    StepStatus::Passed,
                    Some(0),
                    None,
                ),
                step(
                    "test",
                    "bun run test",
                    StepStatus::Failed,
                    Some(1),
                    Some("1 test failed"),
                ),
            ],
            failed_step: Some("test".into()),
        });
        let prompt = reviewer_prompt(&task, "main", true, &checks);

        assert!(
            prompt.contains("GROUND TRUTH"),
            "frames checks as authoritative"
        );
        assert!(
            prompt.contains("bun run test"),
            "embeds the real command line"
        );
        assert!(
            prompt.contains("FAILED (exit 1)"),
            "surfaces the failing check"
        );
        assert!(
            prompt.contains("1 test failed"),
            "attaches the failure evidence"
        );
        assert!(
            prompt.contains("VERDICT: PASS"),
            "verdict contract survives injection"
        );
    }

    #[test]
    fn format_check_results_renders_pass_fail_skip() {
        let out = format_check_results(&GauntletResult {
            passed: false,
            steps: vec![
                step(
                    "typecheck",
                    "bun run typecheck",
                    StepStatus::Passed,
                    Some(0),
                    None,
                ),
                step(
                    "lint",
                    "bun run lint",
                    StepStatus::Failed,
                    Some(2),
                    Some("oops"),
                ),
                step("test", "bun run test", StepStatus::Skipped, None, None),
            ],
            failed_step: Some("lint".into()),
        });
        assert!(out.contains("- typecheck (`bun run typecheck`): PASSED"));
        assert!(out.contains("- lint (`bun run lint`): FAILED (exit 2)"));
        assert!(out.contains("SKIPPED (an earlier check failed)"));
        assert!(out.contains("    oops"), "indents the failure tail");
        assert!(
            out.contains("do NOT attempt"),
            "forbids the read-only reviewer from re-running the checks"
        );
    }

    #[test]
    fn format_check_results_notes_when_no_tooling_detected() {
        // An empty gauntlet (no package.json scripts / no Cargo) is a real "none
        // detected", distinct from a runner failure — the reviewer must be told so.
        let out = format_check_results(&GauntletResult {
            passed: true,
            steps: Vec::new(),
            failed_step: None,
        });
        assert!(
            out.contains("none detected"),
            "distinguishes empty from failure"
        );
        assert!(
            !out.contains("GROUND TRUTH"),
            "no ground-truth header without results"
        );
    }

    #[test]
    fn reviewer_prompt_still_assembles_when_checks_unavailable() {
        // Verification must complete even when the gauntlet could not run: the
        // fallback section is injected and the verdict contract is intact.
        let task = Task::new("Add a feature".into(), String::new());
        let prompt = reviewer_prompt(&task, "main", true, CHECKS_UNAVAILABLE);
        assert!(prompt.contains("unavailable"), "carries the fallback note");
        assert!(prompt.contains("VERDICT: PASS"), "verdict contract intact");
    }
}
