//! The sequential runner + reporting: run the planned checks in `run_dir`
//! (loading the manifest from `manifest_root`), stopping at the first non-zero
//! exit; fold a task's own verify command in as an extra check; and render the
//! `fix_instruction` the auto-fix loop feeds back on failure.

use std::path::Path;

use super::config::load_checks;
use crate::gauntlet::tail_output;
use crate::store::types::{StepStatus, StructureLockCheck, StructureLockResult};

/// Run the structure-lock gauntlet over a directory: load the enabled checks from
/// `.nightcore/harness.json`, run them sequentially, and stop at the first non-zero
/// exit. A project with no config (or no enabled checks) passes trivially.
/// Main-mode shape (the review dir IS the project root, so the manifest and the
/// checks share one dir); worktree mode uses [`run_from`].
pub fn run(dir: &Path) -> StructureLockResult {
    run_from(dir, dir)
}

/// The worktree-parity variant: load the manifest from `manifest_root` (the
/// PROJECT root) while RUNNING the checks in `run_dir` (the review worktree).
/// `.nightcore/` is gitignored, so no manifest copy exists inside a worktree —
/// reading it from the review dir made every project check silently skip for
/// worktree builds (a trivially-green gate). This mirrors how the diff-budget
/// gate deliberately reads the root manifest. `run(dir)` (main mode) is the
/// `manifest_root == run_dir` case, byte-identical to the old behavior.
pub fn run_from(manifest_root: &Path, run_dir: &Path) -> StructureLockResult {
    let planned = load_checks(manifest_root);
    // No config / no enabled checks: trivially passing (mirrors `gauntlet::empty_pass`).
    if planned.is_empty() {
        return empty_pass();
    }
    let mut checks = Vec::with_capacity(planned.len());
    let mut failed_check: Option<String> = None;

    for check in planned {
        let kind = check.kind.as_wire().to_string();
        if failed_check.is_some() {
            // An earlier check failed: record the rest as skipped (stop-at-first).
            checks.push(StructureLockCheck {
                name: check.name,
                kind,
                command: check.command,
                status: StepStatus::Skipped,
                exit_code: None,
                output: None,
            });
            continue;
        }

        tracing::debug!(target: "nightcore::structure_lock", check = %check.name, "running structure-lock check");
        let output = crate::platform::std_command(&check.program)
            .args(&check.args)
            .current_dir(run_dir)
            .output();

        match output {
            Ok(out) if out.status.success() => {
                tracing::info!(target: "nightcore::structure_lock", check = %check.name, exit_code = ?out.status.code(), "structure-lock check passed");
                checks.push(StructureLockCheck {
                    name: check.name,
                    kind,
                    command: check.command,
                    status: StepStatus::Passed,
                    exit_code: out.status.code(),
                    output: None,
                });
            }
            Ok(out) => {
                // Check NAME + exit code only to the log — never the output body
                // (it ships to the UI payload, never to the tracing sink).
                tracing::error!(target: "nightcore::structure_lock", check = %check.name, exit_code = ?out.status.code(), "structure-lock check failed");
                failed_check = Some(check.name.clone());
                checks.push(StructureLockCheck {
                    name: check.name,
                    kind,
                    command: check.command,
                    status: StepStatus::Failed,
                    exit_code: out.status.code(),
                    output: Some(tail_output(&out.stdout, &out.stderr)),
                });
            }
            Err(e) => {
                // The tool couldn't be launched at all (missing from PATH): a real
                // failure for this check — stop here.
                tracing::error!(target: "nightcore::structure_lock", check = %check.name, error = %e, "structure-lock check could not launch");
                failed_check = Some(check.name.clone());
                checks.push(StructureLockCheck {
                    name: check.name,
                    kind,
                    command: check.command,
                    status: StepStatus::Failed,
                    exit_code: None,
                    output: Some(format!("failed to launch: {e}")),
                });
            }
        }
    }

    let passed = failed_check.is_none();
    tracing::info!(target: "nightcore::structure_lock", passed, failed_check = ?failed_check, checks = checks.len(), "structure-lock gauntlet finished");
    StructureLockResult {
        passed,
        checks,
        failed_check,
    }
}

/// A trivially-passing result (no config / no enabled checks). Mirrors
/// [`crate::gauntlet::empty_pass`]. Delegates to the type's own constructor in
/// `store::types` so the empty value has a single definition.
pub fn empty_pass() -> StructureLockResult {
    StructureLockResult::empty_pass()
}

/// The stable check name + wire kind for a task's own verify-command gate. Kept a free
/// string on the result (like every other check kind) so the UI renders it uniformly.
pub(super) const VERIFY_COMMAND_CHECK: &str = "verify-command";

/// Run a task's per-task verify command ([`crate::task::Task::verify_command`], hardening
/// module #1) as an ADDITIONAL Structure-Lock check, folding its outcome into `result`.
/// Called AFTER the project's `.nightcore/harness.json` checks pass, so the task's own gate
/// runs last (stop-at-first already halted the project checks on any earlier failure). A
/// failing command flips `result.passed`/`failed_check`, routing into the exact same
/// bounded auto-fix / park machinery the project checks use — no new failure path. An
/// empty/blank command is a no-op (nothing deterministic to run). Split on whitespace like
/// [`super::config`]'s planner, routed through the platform resolver (Windows-shim aware).
pub fn append_task_verify_command(result: &mut StructureLockResult, command: &str, dir: &Path) {
    let command = command.trim();
    if command.is_empty() {
        return;
    }
    let mut tokens = command.split_whitespace();
    let Some(program) = tokens.next() else {
        return;
    };
    let args: Vec<String> = tokens.map(str::to_string).collect();

    tracing::debug!(target: "nightcore::structure_lock", command = %command, "running task verify command");
    let output = crate::platform::std_command(program)
        .args(&args)
        .current_dir(dir)
        .output();

    let check = match output {
        Ok(out) if out.status.success() => {
            tracing::info!(target: "nightcore::structure_lock", command = %command, exit_code = ?out.status.code(), "task verify command passed");
            StructureLockCheck {
                name: VERIFY_COMMAND_CHECK.to_string(),
                kind: VERIFY_COMMAND_CHECK.to_string(),
                command: command.to_string(),
                status: StepStatus::Passed,
                exit_code: out.status.code(),
                output: None,
            }
        }
        Ok(out) => {
            tracing::error!(target: "nightcore::structure_lock", command = %command, exit_code = ?out.status.code(), "task verify command failed");
            result.passed = false;
            result.failed_check = Some(VERIFY_COMMAND_CHECK.to_string());
            StructureLockCheck {
                name: VERIFY_COMMAND_CHECK.to_string(),
                kind: VERIFY_COMMAND_CHECK.to_string(),
                command: command.to_string(),
                status: StepStatus::Failed,
                exit_code: out.status.code(),
                output: Some(tail_output(&out.stdout, &out.stderr)),
            }
        }
        Err(e) => {
            tracing::error!(target: "nightcore::structure_lock", command = %command, error = %e, "task verify command could not launch");
            result.passed = false;
            result.failed_check = Some(VERIFY_COMMAND_CHECK.to_string());
            StructureLockCheck {
                name: VERIFY_COMMAND_CHECK.to_string(),
                kind: VERIFY_COMMAND_CHECK.to_string(),
                command: command.to_string(),
                status: StepStatus::Failed,
                exit_code: None,
                output: Some(format!("failed to launch: {e}")),
            }
        }
    };
    result.checks.push(check);
}

/// A human-readable fix instruction for the auto-fix loop, naming the failed check,
/// its exact command, and the captured output so the agent can self-correct. Pure,
/// so it's unit-testable without spawning anything.
pub fn fix_instruction(result: &StructureLockResult) -> String {
    match result
        .checks
        .iter()
        .find(|c| c.status == StepStatus::Failed)
    {
        Some(c) => format!(
            "The Structure-Lock Gauntlet failed: the project's own harness check \
             `{name}` did not pass. It MUST pass before this work can be verified or \
             merged. Re-run it locally and fix every violation it reports:\n\n\
             Command: {command}\n\nOutput:\n{output}",
            name = c.name,
            command = c.command,
            output = c.output.as_deref().unwrap_or("(no output captured)"),
        ),
        None => "The Structure-Lock Gauntlet failed. Fix the project's harness \
                 checks before this work can be verified or merged."
            .to_string(),
    }
}
