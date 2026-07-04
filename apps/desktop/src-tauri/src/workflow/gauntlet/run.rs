//! The sequential runner + failure-output reporting: run the detected steps in
//! order, **stopping at the first non-zero exit**, and truncate a failing step's
//! output from the tail. A project with no detected tooling passes trivially.

use std::path::Path;

use super::detect::detect_steps;
use super::{GauntletResult, GauntletStep};
use crate::store::types::StepStatus;

/// How much of a failing step's output to retain for the UI. Bounded so a noisy
/// failure can't bloat the event payload; truncated from the tail (the part that
/// usually names the failure).
const TAIL_LIMIT: usize = 4000;

/// Run the gauntlet over a worktree directory: detect the steps, run them
/// sequentially, and stop at the first non-zero exit. A project with no detected
/// tooling passes trivially.
pub fn run(dir: &Path) -> GauntletResult {
    let planned = detect_steps(dir);
    let mut steps = Vec::with_capacity(planned.len());
    let mut failed_step: Option<String> = None;

    for step in planned {
        let command = step.command_line();
        if failed_step.is_some() {
            // An earlier step failed: record the rest as skipped (stop-at-first).
            steps.push(GauntletStep {
                name: step.name,
                command,
                status: StepStatus::Skipped,
                exit_code: None,
                output: None,
            });
            continue;
        }

        tracing::debug!(target: "nightcore::gauntlet", step = %step.name, "running gauntlet step");
        // Route the bare program name (`bun`/`npm`/`cargo`) through the platform
        // resolver so it launches through Windows npm shims like the sidecar spawn
        // does — `Command::new("bun")` is unspawnable when only `bun.cmd` is on PATH.
        let output = crate::platform::std_command(&step.program)
            .args(&step.args)
            .current_dir(dir)
            .output();

        match output {
            Ok(out) if out.status.success() => {
                tracing::info!(target: "nightcore::gauntlet", step = %step.name, exit_code = ?out.status.code(), "gauntlet step passed");
                steps.push(GauntletStep {
                    name: step.name,
                    command,
                    status: StepStatus::Passed,
                    exit_code: out.status.code(),
                    output: None,
                });
            }
            Ok(out) => {
                // Step NAME + exit code only — never the output body (debug-only via
                // the UI payload; never to the log).
                tracing::error!(target: "nightcore::gauntlet", step = %step.name, exit_code = ?out.status.code(), "gauntlet step failed");
                failed_step = Some(step.name.clone());
                steps.push(GauntletStep {
                    name: step.name,
                    command,
                    status: StepStatus::Failed,
                    exit_code: out.status.code(),
                    output: Some(tail_output(&out.stdout, &out.stderr)),
                });
            }
            Err(e) => {
                // The tool couldn't be launched at all (missing from PATH): a real
                // failure for this step — stop here.
                tracing::error!(target: "nightcore::gauntlet", step = %step.name, error = %e, "gauntlet step could not launch");
                failed_step = Some(step.name.clone());
                steps.push(GauntletStep {
                    name: step.name,
                    command,
                    status: StepStatus::Failed,
                    exit_code: None,
                    output: Some(format!("failed to launch: {e}")),
                });
            }
        }
    }

    let passed = failed_step.is_none();
    tracing::info!(target: "nightcore::gauntlet", passed, failed_step = ?failed_step, steps = steps.len(), "gauntlet finished");
    GauntletResult {
        passed,
        steps,
        failed_step,
    }
}

/// Combine stdout+stderr and keep the last [`TAIL_LIMIT`] bytes (the part that
/// usually names the failure), as UTF-8-lossy text. Shared with the Structure-Lock
/// Gauntlet (`gauntlet_project`) so both gates truncate identically.
pub(crate) fn tail_output(stdout: &[u8], stderr: &[u8]) -> String {
    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(stdout));
    if !stderr.is_empty() {
        combined.push('\n');
        combined.push_str(&String::from_utf8_lossy(stderr));
    }
    if combined.len() > TAIL_LIMIT {
        let start = combined.len() - TAIL_LIMIT;
        // Snap to a char boundary so we never slice mid-codepoint.
        let start = (start..combined.len())
            .find(|&i| combined.is_char_boundary(i))
            .unwrap_or(combined.len());
        format!("…{}", &combined[start..])
    } else {
        combined
    }
}

/// A trivially-passing result (no worktree / no tooling to run).
pub fn empty_pass() -> GauntletResult {
    GauntletResult {
        passed: true,
        steps: Vec::new(),
        failed_step: None,
    }
}
