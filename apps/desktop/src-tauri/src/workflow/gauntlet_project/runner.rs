//! The runner + reporting: run the planned checks in `run_dir` (loading the
//! manifest from `manifest_root`) in FULL-RUN mode — every check runs and every
//! failure is recorded (no stop-at-first), so a single fix session sees the whole
//! set instead of discovering failures one paid round at a time. Each check is
//! wall-clock BOUNDED (a hung check is killed, never blocks verification forever)
//! and RETRIED ONCE on failure: a check that fails then passes is marked `flaky`
//! (a non-failure the gate ignores) rather than burning a fix session on a flake.
//! Per-check duration is recorded. A task's own verify command folds in as an
//! extra check, and `fix_instruction` renders the aggregate feedback the auto-fix
//! loop feeds back on failure. Security-critical kinds (`secret-scan`,
//! `mutation-score`) are EXCLUDED from the retry: a failure blocks immediately
//! rather than getting a second chance to flip green (and a side-effecting check
//! is not run twice).

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use super::config::{load_checks, DEFAULT_CHECK_TIMEOUT};
use crate::infra::text::tail_output;
use crate::store::types::{StepStatus, StructureLockCheck, StructureLockResult};

/// Run the structure-lock gauntlet over a directory: load the enabled checks from
/// `.nightcore/harness.json` and run them ALL (full-run mode), recording every
/// failure. A project with no config (or no enabled checks) passes trivially.
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
/// `manifest_root == run_dir` case.
///
/// FULL-RUN semantics: unlike the old stop-at-first loop, every enabled check
/// runs and records its own outcome, so a failing round hands the fix loop the
/// COMPLETE failure set. `passed` is false iff any check ended `failed`; a `flaky`
/// check (failed once, passed on retry) does NOT flip it. `failed_check` names the
/// FIRST failed check (back-compat for the fix-routing / merge-gate machinery).
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
        tracing::debug!(target: "nightcore::structure_lock", check = %check.name, "running structure-lock check");
        // Security-critical kinds are excluded from flaky-retry: a failure blocks.
        let outcome = run_check_with_retry(
            &check.program,
            &check.args,
            run_dir,
            check.timeout,
            check.kind.is_security_critical(),
        );

        match outcome.status {
            StepStatus::Passed => {
                tracing::info!(target: "nightcore::structure_lock", check = %check.name, exit_code = ?outcome.exit_code, duration_ms = outcome.duration_ms, "structure-lock check passed");
            }
            StepStatus::Flaky => {
                tracing::warn!(target: "nightcore::structure_lock", check = %check.name, exit_code = ?outcome.exit_code, duration_ms = outcome.duration_ms, "structure-lock check flaky (failed once, passed on retry)");
            }
            StepStatus::Failed => {
                // Check NAME + exit code only to the log — never the output body
                // (it ships to the UI payload, never to the tracing sink).
                tracing::error!(target: "nightcore::structure_lock", check = %check.name, exit_code = ?outcome.exit_code, duration_ms = outcome.duration_ms, "structure-lock check failed");
                if failed_check.is_none() {
                    failed_check = Some(check.name.clone());
                }
            }
            // The runner never emits `Skipped` in full-run mode (kept exhaustive).
            StepStatus::Skipped => {}
        }

        checks.push(StructureLockCheck {
            name: check.name,
            kind,
            command: check.command,
            status: outcome.status,
            exit_code: outcome.exit_code,
            output: outcome.output,
            duration_ms: Some(outcome.duration_ms),
        });
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

/// The resolved outcome of running one check (after the retry-once policy). `status`
/// is `Passed` (first try), `Flaky` (failed then passed), or `Failed` (both tries);
/// `duration_ms` sums every attempt made.
struct CheckOutcome {
    status: StepStatus,
    exit_code: Option<i32>,
    /// The failure tail (for `failed`) or the first-attempt tail annotated as flaky
    /// (for `flaky`). `None` for a clean first-try pass.
    output: Option<String>,
    duration_ms: u64,
}

/// The result of ONE spawn attempt (before the retry policy is applied).
struct Attempt {
    ok: bool,
    exit_code: Option<i32>,
    /// The failure tail / launch or timeout message; `None` on success.
    output: Option<String>,
    duration_ms: u64,
}

/// Run `program args` in `dir`, bounded by `timeout`. Never blocks past the
/// deadline: an overrunning child is killed + reaped and reported as a failure
/// (fail-closed — a timeout is NEVER a silent pass). Pure spawn mechanics; the
/// retry policy lives in [`run_check_with_retry`].
fn run_check_once(program: &str, args: &[String], dir: &Path, timeout: Duration) -> Attempt {
    let start = Instant::now();
    let spawned = crate::platform::std_command(program)
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let child = match spawned {
        Ok(child) => child,
        Err(e) => {
            // The tool couldn't be launched at all (missing from PATH): a real
            // failure for this check.
            return Attempt {
                ok: false,
                exit_code: None,
                output: Some(format!("failed to launch: {e}")),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    match crate::git::run::drain_and_wait(child, None, timeout) {
        Ok(Some(out)) if out.status.success() => Attempt {
            ok: true,
            exit_code: out.status.code(),
            output: None,
            duration_ms: start.elapsed().as_millis() as u64,
        },
        Ok(Some(out)) => Attempt {
            ok: false,
            exit_code: out.status.code(),
            output: Some(tail_output(out.stdout.as_bytes(), out.stderr.as_bytes())),
            duration_ms: start.elapsed().as_millis() as u64,
        },
        // Deadline elapsed: the child was killed + reaped. Fail-closed with an
        // explicit timeout note — never a silent pass.
        Ok(None) => Attempt {
            ok: false,
            exit_code: None,
            output: Some(format!(
                "timed out after {}ms (the check was killed; it may hang or need a higher timeoutMs)",
                timeout.as_millis()
            )),
            duration_ms: start.elapsed().as_millis() as u64,
        },
        Err(e) => Attempt {
            ok: false,
            exit_code: None,
            output: Some(format!("could not run the check: {e}")),
            duration_ms: start.elapsed().as_millis() as u64,
        },
    }
}

/// Run a check with the retry-once flaky policy: run it; on any failure (non-zero
/// exit, launch failure, or timeout) run it ONE more time. A check that then
/// passes is `Flaky` — a non-failure the gate ignores, so a flake no longer burns
/// a fix session — while a check that fails BOTH times is `Failed`. Each attempt
/// is independently bounded by `timeout`, so the worst case is `2 * timeout`.
///
/// When `security_critical` is true the retry is SUPPRESSED: the first failure is
/// the verdict (`Failed`), so a security check (`secret-scan` / `mutation-score`)
/// that ever fails BLOCKS instead of being masked as a non-blocking `flaky` pass —
/// and a side-effecting check is never run twice. See
/// [`super::config::HarnessCheckKind::is_security_critical`].
fn run_check_with_retry(
    program: &str,
    args: &[String],
    dir: &Path,
    timeout: Duration,
    security_critical: bool,
) -> CheckOutcome {
    let first = run_check_once(program, args, dir, timeout);
    if first.ok {
        return CheckOutcome {
            status: StepStatus::Passed,
            exit_code: first.exit_code,
            output: None,
            duration_ms: first.duration_ms,
        };
    }

    // A security-critical check gets NO second chance: a single failure blocks
    // (never a `flaky` pass), and a side-effecting check isn't run twice.
    if security_critical {
        return CheckOutcome {
            status: StepStatus::Failed,
            exit_code: first.exit_code,
            output: first.output,
            duration_ms: first.duration_ms,
        };
    }

    // First attempt failed — retry ONCE.
    let second = run_check_once(program, args, dir, timeout);
    let duration_ms = first.duration_ms + second.duration_ms;
    if second.ok {
        // Failed then passed: a flake, not a real failure. Keep the first
        // attempt's tail so a user can see WHAT flaked, annotated as such.
        let note = match first.output {
            Some(tail) => format!("flaky: failed once, passed on retry. First failure:\n{tail}"),
            None => "flaky: failed once, passed on retry.".to_string(),
        };
        CheckOutcome {
            status: StepStatus::Flaky,
            exit_code: second.exit_code,
            output: Some(note),
            duration_ms,
        }
    } else {
        // Both attempts failed — a genuine failure. Report the second attempt's
        // evidence (the retry the user would reproduce).
        CheckOutcome {
            status: StepStatus::Failed,
            exit_code: second.exit_code,
            output: second.output,
            duration_ms,
        }
    }
}

/// Run a task's per-task verify command ([`crate::task::Task::verify_command`], hardening
/// module #1) as an ADDITIONAL Structure-Lock check, folding its outcome into `result`.
/// Called AFTER the project's `.nightcore/harness.json` checks run, so the task's own gate
/// runs last. It gets the SAME robustness as the manifest checks: bounded by
/// [`DEFAULT_CHECK_TIMEOUT`], retried once (flaky ⇒ not a failure), and duration-recorded.
/// A failing command flips `result.passed`/`failed_check`, routing into the exact same
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
    // The task's own verify command is not a security kind; it keeps its flaky-retry.
    let outcome = run_check_with_retry(program, &args, dir, DEFAULT_CHECK_TIMEOUT, false);

    match outcome.status {
        StepStatus::Passed => {
            tracing::info!(target: "nightcore::structure_lock", command = %command, exit_code = ?outcome.exit_code, duration_ms = outcome.duration_ms, "task verify command passed");
        }
        StepStatus::Flaky => {
            tracing::warn!(target: "nightcore::structure_lock", command = %command, exit_code = ?outcome.exit_code, duration_ms = outcome.duration_ms, "task verify command flaky (failed once, passed on retry)");
        }
        StepStatus::Failed => {
            tracing::error!(target: "nightcore::structure_lock", command = %command, exit_code = ?outcome.exit_code, duration_ms = outcome.duration_ms, "task verify command failed");
            result.passed = false;
            if result.failed_check.is_none() {
                result.failed_check = Some(VERIFY_COMMAND_CHECK.to_string());
            }
        }
        StepStatus::Skipped => {}
    }

    result.checks.push(StructureLockCheck {
        name: VERIFY_COMMAND_CHECK.to_string(),
        kind: VERIFY_COMMAND_CHECK.to_string(),
        command: command.to_string(),
        status: outcome.status,
        exit_code: outcome.exit_code,
        output: outcome.output,
        duration_ms: Some(outcome.duration_ms),
    });
}

/// A human-readable fix instruction for the auto-fix loop. In full-run mode the
/// gauntlet records EVERY failing check, so the instruction lists them ALL (each
/// with its exact command + captured output) — one fix session then addresses the
/// whole set instead of rediscovering failures one paid round at a time. Pure, so
/// it's unit-testable without spawning anything. `flaky` checks are omitted (they
/// passed on retry and are not failures).
pub fn fix_instruction(result: &StructureLockResult) -> String {
    let failed: Vec<&StructureLockCheck> = result
        .checks
        .iter()
        .filter(|c| c.status == StepStatus::Failed)
        .collect();

    if failed.is_empty() {
        return "The Structure-Lock Gauntlet failed. Fix the project's harness \
                checks before this work can be verified or merged."
            .to_string();
    }

    let mut out = format!(
        "The Structure-Lock Gauntlet failed: {} project harness check{} did not \
         pass. They MUST all pass before this work can be verified or merged. \
         Re-run each one locally and fix every violation it reports:",
        failed.len(),
        if failed.len() == 1 { "" } else { "s" },
    );
    for c in failed {
        out.push_str(&format!(
            "\n\n--- `{name}` ---\nCommand: {command}\n\nOutput:\n{output}",
            name = c.name,
            command = c.command,
            output = c.output.as_deref().unwrap_or("(no output captured)"),
        ));
    }
    out
}
