//! Reviewer/fix session dispatch and the core-owned prompts (M4 §B). Starts the
//! read-only reviewer over the build's worktree, and the bounded fix-build for a
//! `CHANGES_REQUESTED` verdict; owns the auto-fix budget [`MAX_FIX_ATTEMPTS`].

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::provider::{Provider, SidecarProvider};
use crate::worktree;
use crate::project::ProjectStore;
use crate::store::TaskStore;
use crate::task::{Task, TaskKind};

use crate::sidecar::commands::{
    resolve_context_pack, resolve_harness_policy, resolve_ledger_path, resolve_mcp_servers,
    resolve_permission_mode,
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
    let prompt = reviewer_prompt(&task, &base, has_branch);
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
    let provider = app.state::<std::sync::Arc<SidecarProvider>>();
    let store = app.state::<TaskStore>();
    let task = store.get(task_id).ok_or("task vanished before fix")?;
    let prompt = format!(
        "{}\n\n--- A reviewer requested changes ---\n{}",
        task.prompt(),
        review_text
    );
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
    use super::reviewer_prompt;
    use crate::task::Task;

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
}
