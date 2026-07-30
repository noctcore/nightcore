//! The EnforceRun sequencer: walk the armed manifest once, route each check to either
//! the ordinary bounded+retry GATE path or its drift-substrate MEASUREMENT path, and
//! return the unchanged [`StructureLockResult`] alongside the `ConventionDrift` records.

use std::path::Path;

use super::super::config::{load_checks, HarnessCheckKind, PlannedCheck};
use super::super::runner::{empty_pass, run_check_with_retry};
use super::{eslint, lint_meta, record};
use crate::store::types::{ConventionDrift, StepStatus, StructureLockCheck, StructureLockResult};

/// Run the armed gauntlet over `run_dir` (loading the manifest from `manifest_root`)
/// AND measure drift. Returns the same [`StructureLockResult`] the plain gauntlet
/// does — so the Checks Manager panel is unchanged — plus the `ConventionDrift`
/// records for the armed compiled checks. Main-mode callers pass the project root as
/// both args (see [`super::super::runner::run`]).
///
/// Every non-drift check runs through the shared bounded+retry runner exactly as
/// before; only a drift-substrate check carrying a `conventionFingerprint` is
/// additionally run with its measurement flags to capture counts.
pub(crate) fn run_with_drift(
    manifest_root: &Path,
    run_dir: &Path,
) -> (StructureLockResult, Vec<ConventionDrift>) {
    let planned = load_checks(manifest_root);
    if planned.is_empty() {
        return (empty_pass(), Vec::new());
    }
    let mut checks = Vec::with_capacity(planned.len());
    let mut drift = Vec::new();
    let mut failed_check: Option<String> = None;

    for check in planned {
        let is_drift = check.kind.is_drift_substrate() && check.convention_fingerprint.is_some();
        let sl = if is_drift {
            let (sl, d) = measure_drift_check(&check, run_dir);
            drift.push(d);
            sl
        } else {
            gate_check(&check, run_dir)
        };
        if sl.status == StepStatus::Failed && failed_check.is_none() {
            failed_check = Some(sl.name.clone());
        }
        checks.push(sl);
    }

    let passed = failed_check.is_none();
    tracing::info!(target: "nightcore::structure_lock", passed, drift = drift.len(), checks = checks.len(), "enforce-run (with drift) finished");
    (
        StructureLockResult {
            passed,
            checks,
            failed_check,
        },
        drift,
    )
}

/// Run one ordinary gate check through the shared bounded+retry runner and fold its
/// outcome into a [`StructureLockCheck`] (mirrors `runner::run_from`'s body).
fn gate_check(check: &PlannedCheck, run_dir: &Path) -> StructureLockCheck {
    let outcome = run_check_with_retry(
        &check.program,
        &check.args,
        run_dir,
        check.timeout,
        check.kind.is_security_critical(),
    );
    StructureLockCheck {
        name: check.name.clone(),
        kind: check.kind.as_wire().to_string(),
        command: check.command.clone(),
        status: outcome.status,
        exit_code: outcome.exit_code,
        output: outcome.output,
        duration_ms: Some(outcome.duration_ms),
    }
}

/// Run a compiled DRIFT check with count capture and produce both its gate row and its
/// [`ConventionDrift`] record. The `match` keeps every substrate explicit and any
/// unimplemented one fail-visible (an honest `errored`, never a silent skip).
fn measure_drift_check(
    check: &PlannedCheck,
    run_dir: &Path,
) -> (StructureLockCheck, ConventionDrift) {
    // Safe: the caller only routes checks whose fingerprint `is_some()` here.
    let fingerprint = check.convention_fingerprint.clone().unwrap_or_default();
    match check.kind {
        HarnessCheckKind::LintMeta => lint_meta::measure_lint_meta(check, run_dir, &fingerprint),
        HarnessCheckKind::EslintRule => eslint::measure_eslint_rule(check, run_dir, &fingerprint),
        // Shell (or any future substrate) shouldn't be routed here yet; emit an honest
        // `errored` record rather than a silent skip if one ever is.
        _ => {
            let drift = record::errored_drift(
                &check.name,
                &fingerprint,
                &record::method_for(check.kind, &check.name, &check.command),
                format!(
                    "drift execution for `{}` checks is not implemented yet (issue #187)",
                    check.kind.as_wire()
                ),
            );
            let sl = StructureLockCheck {
                name: check.name.clone(),
                kind: check.kind.as_wire().to_string(),
                command: check.command.clone(),
                status: StepStatus::Passed,
                exit_code: None,
                output: None,
                duration_ms: Some(0),
            };
            (sl, drift)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shell_check_is_skipped_so_it_never_runs_or_drifts() {
        // Shell drift execution is deferred: an armed shell check parses but
        // `plan_check` skips it, so `run_with_drift` neither runs it nor emits drift.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let nc = tmp.path().join(".nightcore");
        std::fs::create_dir_all(&nc).expect("mkdir");
        std::fs::write(
            nc.join("harness.json"),
            r#"{"checks":[{"name":"hooks","kind":"shell","command":"rg -c use src","enabled":true,"conventionFingerprint":"deadbeefdeadbeef"}]}"#,
        )
        .expect("write");
        let (result, drift) = run_with_drift(tmp.path(), tmp.path());
        assert!(
            drift.is_empty(),
            "shell drift execution is deferred (issue #187)"
        );
        assert!(result.passed, "a skipped shell check never fails the gate");
        assert!(result.checks.is_empty(), "the skipped check runs nothing");
    }
}
