//! EnforceRun — run the armed checks AND measure convention DRIFT (Drift-v1, T15).
//!
//! The Enforce stage ships coverage ("is there a rule?"), not conformance ("is it
//! FOLLOWED at every site?"). This is the conformance leg: an EnforceRun runs the
//! human-ARMED checks and, for each compiled DRIFT check (a `lint-meta` / `shell`
//! substrate carrying a `conventionFingerprint`), turns its output into per-site
//! counts and a [`ConventionDrift`] record joined back to the convention.
//!
//! v0.3 scope (see `docs/research/2026-07-11-drift-v1-spec.md`):
//!   - **lint-meta** drift is measured END TO END — we own the substrate, so the run
//!     appends the slice-3 `--json` reporter and parses definitive per-rule counts.
//!   - **shell** drift is ARMABLE + shape-validated (`super::command_guard`) but its
//!     execution/counting is a fast-follow (issue #187): [`super::config::plan_check`]
//!     skips shell checks, so this pass never sees one. When shell execution lands it
//!     plugs in here beside the lint-meta arm.
//!
//! Non-negotiable product rule: NEVER emit `clean`/`drifted` without a `method` + real
//! counts. A check whose output can't be turned into confident counts is `errored`
//! (fail-visible), never silently `clean`.
//!
//! Drift is emitted ONLY for armed checks that carry a `conventionFingerprint` (an
//! EnforceRun is project-scoped and reads only the manifest — it has no access to the
//! scan's full convention set, so the UI derives `uncheckable` for conventions with no
//! armed check).

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Deserialize;

use super::config::{load_checks, HarnessCheckKind, PlannedCheck};
use super::runner::{empty_pass, run_check_with_retry};
use crate::infra::text::tail_output;
use crate::store::types::{ConventionDrift, StepStatus, StructureLockCheck, StructureLockResult};

/// Drift statuses as their wire strings (mirroring `ConventionDriftStatusSchema`).
const STATUS_CLEAN: &str = "clean";
const STATUS_DRIFTED: &str = "drifted";
const STATUS_ERRORED: &str = "errored";

/// Run the armed gauntlet over `run_dir` (loading the manifest from `manifest_root`)
/// AND measure drift. Returns the same [`StructureLockResult`] the plain gauntlet
/// does — so the Checks Manager panel is unchanged — plus the `ConventionDrift`
/// records for the armed compiled checks. Main-mode callers pass the project root as
/// both args (see [`super::runner::run`]).
///
/// Every non-drift check runs through the shared bounded+retry runner exactly as
/// before; only a lint-meta check carrying a `conventionFingerprint` is additionally
/// run with the `--json` reporter to capture counts.
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
/// outcome into a [`StructureLockCheck`] (mirrors [`super::runner::run_from`]'s body).
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
/// [`ConventionDrift`] record. Today only `lint-meta` reaches here (shell execution is
/// deferred — [`super::config::plan_check`] skips it); the `match` makes the future
/// shell arm explicit and keeps a stray non-lint-meta substrate fail-visible.
fn measure_drift_check(
    check: &PlannedCheck,
    run_dir: &Path,
) -> (StructureLockCheck, ConventionDrift) {
    // Safe: the caller only routes checks whose fingerprint `is_some()` here.
    let fingerprint = check.convention_fingerprint.clone().unwrap_or_default();
    match check.kind {
        HarnessCheckKind::LintMeta => measure_lint_meta(check, run_dir, &fingerprint),
        // Shell (or any future substrate) shouldn't be routed here yet; emit an honest
        // `errored` record rather than a silent skip if one ever is.
        _ => {
            let drift = errored_drift(
                &check.name,
                &fingerprint,
                &method_for(check.kind, &check.name, &check.command),
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

/// Run a lint-meta check with the `--json` reporter, capturing stdout, and turn the
/// report into a [`ConventionDrift`]. The gate row reflects whether the run itself
/// completed (a lint-meta `--json` run exits 0 by design; a spawn/timeout is `Failed`)
/// — the CONFORMANCE lives on the drift record, not the gate row.
fn measure_lint_meta(
    check: &PlannedCheck,
    run_dir: &Path,
    fingerprint: &str,
) -> (StructureLockCheck, ConventionDrift) {
    let args = with_json_flag(&check.args);
    let cap = run_capture(&check.program, &args, run_dir, check.timeout);

    let drift = drift_from_lint_meta(
        &check.name,
        fingerprint,
        &cap.stdout,
        cap.run_error.as_deref(),
    );

    // Gate row: a completed run (exit 0, the `--json` reporter's contract) is `Passed`;
    // a spawn/timeout/non-zero exit is `Failed` (the run couldn't measure anything).
    let status = if cap.run_error.is_none() && cap.exit_code == Some(0) {
        StepStatus::Passed
    } else {
        StepStatus::Failed
    };
    let sl = StructureLockCheck {
        name: check.name.clone(),
        kind: check.kind.as_wire().to_string(),
        command: check.command.clone(),
        status,
        exit_code: cap.exit_code,
        output: cap.run_error.clone(),
        duration_ms: Some(cap.duration_ms),
    };
    (sl, drift)
}

/// Ensure the lint-meta run emits the machine-readable report: append `--json` unless
/// the compiled command already carries it (synthesis emits `bun run lint:meta`).
fn with_json_flag(args: &[String]) -> Vec<String> {
    let mut out = args.to_vec();
    if !out.iter().any(|a| a == "--json") {
        out.push("--json".to_string());
    }
    out
}

/// The `--json` payload shape (a subset of `tools/lint-meta/json-reporter.ts`'s stable
/// contract — extend additively only): per-rule `counts` (every rule that RAN, incl.
/// 0), the `errored` rule ids (excluded from `counts`), and the `total` across rules.
#[derive(Debug, Default, Deserialize)]
struct LintMetaReport {
    #[serde(default)]
    counts: BTreeMap<String, u64>,
    #[serde(default)]
    errored: Vec<String>,
    #[serde(default)]
    total: u64,
}

/// Build a [`ConventionDrift`] from a lint-meta `--json` run. PURE (no I/O) so the
/// status mapping is unit-testable without spawning.
///
/// Attribution: a compiled lint-meta check's `name` is its rule id (synthesis names
/// the check after the rule, e.g. `folder-per-component`), so when the report's
/// `counts` carries that key we attribute PER RULE; otherwise we fall back to the
/// suite `total`. `sitesMatched` is the violating-site count; `sitesChecked` is a
/// definitiveness lower-bound (`≥ sitesMatched`, `≥1` once a rule ran) — lint-meta
/// reports counts, not files-scanned, so this is not a literal file total, but it is
/// `>0` EXACTLY when a definitive measurement exists, which is what the fail-visible
/// product rule needs to license `clean`.
fn drift_from_lint_meta(
    name: &str,
    fingerprint: &str,
    stdout: &str,
    run_error: Option<&str>,
) -> ConventionDrift {
    let method = format!("lint-meta: {name}");

    let Some(report) =
        extract_json(stdout).and_then(|j| serde_json::from_str::<LintMetaReport>(j).ok())
    else {
        // No parseable report: the run couldn't measure anything → fail-visible errored.
        let reason = run_error
            .map(str::to_string)
            .unwrap_or_else(|| "lint-meta `--json` output was not valid JSON".to_string());
        return errored_drift(name, fingerprint, &method, reason);
    };

    // A rule that threw is fail-visible: it produced no count, so never "clean".
    if report.errored.iter().any(|r| r == name) {
        return errored_drift(
            name,
            fingerprint,
            &method,
            format!("the lint-meta rule `{name}` threw during the run"),
        );
    }

    // No rule ran at all (empty registry / every rule errored) ⇒ no measurement.
    if report.counts.is_empty() {
        return errored_drift(
            name,
            fingerprint,
            &method,
            "no lint-meta rules ran, so drift could not be measured".to_string(),
        );
    }

    let matched = report.counts.get(name).copied().unwrap_or(report.total);
    let checked = matched.max(1); // ≥ matched, and ≥1 ⇒ a 0-match run is a real `clean`.
    let status = if matched == 0 {
        STATUS_CLEAN
    } else {
        STATUS_DRIFTED
    };

    ConventionDrift {
        id: drift_id(fingerprint),
        convention_fingerprint: fingerprint.to_string(),
        category: String::new(), // the UI backfills the lens via the fingerprint join.
        title: name.to_string(),
        status: status.to_string(),
        method,
        sites_matched: matched,
        sites_checked: checked,
        check_name: Some(name.to_string()),
        error_reason: None,
        fingerprint: fingerprint.to_string(),
    }
}

/// The `errored` drift record — fail-visible with zeroed counts + a human reason.
fn errored_drift(name: &str, fingerprint: &str, method: &str, reason: String) -> ConventionDrift {
    ConventionDrift {
        id: drift_id(fingerprint),
        convention_fingerprint: fingerprint.to_string(),
        category: String::new(),
        title: name.to_string(),
        status: STATUS_ERRORED.to_string(),
        method: method.to_string(),
        sites_matched: 0,
        sites_checked: 0,
        check_name: Some(name.to_string()),
        error_reason: Some(reason),
        fingerprint: fingerprint.to_string(),
    }
}

/// `method` string (ALWAYS rendered): the tool + rule/name that determined the drift.
fn method_for(kind: HarnessCheckKind, name: &str, command: &str) -> String {
    match kind {
        HarnessCheckKind::LintMeta => format!("lint-meta: {name}"),
        HarnessCheckKind::Shell => format!("shell: {command}"),
        other => format!("{}: {name}", other.as_wire()),
    }
}

/// Stable drift id / carry-forward key: `drift-<conventionFingerprint>`.
fn drift_id(fingerprint: &str) -> String {
    format!("drift-{fingerprint}")
}

/// Extract the `{ … }` JSON object from captured stdout. The lint-meta CLI prints only
/// the JSON on `--json`, but a script runner could prepend a banner line, so we slice
/// from the first `{` to the last `}` (returns `None` when there is no object at all).
fn extract_json(stdout: &str) -> Option<&str> {
    let start = stdout.find('{')?;
    let end = stdout.rfind('}')?;
    if end < start {
        return None;
    }
    Some(&stdout[start..=end])
}

/// One bounded capture of a subprocess, keeping FULL stdout (the drift parser needs the
/// whole `--json` payload — the gate runner only keeps a failure tail). Mirrors
/// [`super::runner`]'s spawn mechanics; a spawn error / timeout / non-zero exit is
/// surfaced via `run_error` (fail-visible — never a silent empty measurement).
struct CaptureOutcome {
    exit_code: Option<i32>,
    stdout: String,
    /// A launch / timeout / non-zero-exit message; `None` on a clean exit-0 run.
    run_error: Option<String>,
    duration_ms: u64,
}

fn run_capture(program: &str, args: &[String], dir: &Path, timeout: Duration) -> CaptureOutcome {
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
            return CaptureOutcome {
                exit_code: None,
                stdout: String::new(),
                run_error: Some(format!("failed to launch `{program}`: {e}")),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    match crate::git::run::drain_and_wait(child, None, timeout) {
        Ok(Some(out)) => {
            let run_error = if out.status.success() {
                None
            } else {
                Some(tail_output(out.stdout.as_bytes(), out.stderr.as_bytes()))
            };
            CaptureOutcome {
                exit_code: out.status.code(),
                stdout: out.stdout,
                run_error,
                duration_ms: start.elapsed().as_millis() as u64,
            }
        }
        Ok(None) => CaptureOutcome {
            exit_code: None,
            stdout: String::new(),
            run_error: Some(format!(
                "timed out after {}ms (the check was killed)",
                timeout.as_millis()
            )),
            duration_ms: start.elapsed().as_millis() as u64,
        },
        Err(e) => CaptureOutcome {
            exit_code: None,
            stdout: String::new(),
            run_error: Some(format!("could not run the check: {e}")),
            duration_ms: start.elapsed().as_millis() as u64,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "a1b2c3d4e5f60718";

    /// A `--json` report with the given per-rule counts (+ optional errored ids).
    fn report_json(counts: &[(&str, u64)], errored: &[&str]) -> String {
        let counts_obj: BTreeMap<String, u64> =
            counts.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        let total: u64 = counts.iter().map(|(_, v)| v).sum();
        serde_json::json!({
            "violations": [],
            "counts": counts_obj,
            "errored": errored,
            "total": total,
        })
        .to_string()
    }

    #[test]
    fn clean_when_the_rule_ran_and_matched_zero() {
        let out = report_json(&[("folder-per-component", 0), ("other-rule", 3)], &[]);
        let d = drift_from_lint_meta("folder-per-component", FP, &out, None);
        assert_eq!(d.status, STATUS_CLEAN);
        assert_eq!(d.sites_matched, 0);
        assert!(
            d.sites_checked > 0,
            "a real clean must carry sitesChecked>0"
        );
        assert_eq!(d.id, "drift-a1b2c3d4e5f60718");
        assert_eq!(d.method, "lint-meta: folder-per-component");
        assert_eq!(d.fingerprint, FP);
        assert!(d.error_reason.is_none());
    }

    #[test]
    fn drifted_attributes_the_matching_rule_by_name() {
        // The convention's rule matched 4 sites; a sibling rule's 9 must NOT bleed in.
        let out = report_json(&[("folder-per-component", 4), ("other-rule", 9)], &[]);
        let d = drift_from_lint_meta("folder-per-component", FP, &out, None);
        assert_eq!(d.status, STATUS_DRIFTED);
        assert_eq!(d.sites_matched, 4);
        assert!(
            d.sites_checked >= d.sites_matched,
            "checked is a lower bound ≥ matched"
        );
    }

    #[test]
    fn falls_back_to_total_when_the_name_is_not_a_rule_id() {
        // The check name doesn't match any rule id → attribute the suite total.
        let out = report_json(&[("rule-a", 2), ("rule-b", 5)], &[]);
        let d = drift_from_lint_meta("some-textual-convention", FP, &out, None);
        assert_eq!(d.status, STATUS_DRIFTED);
        assert_eq!(d.sites_matched, 7);
    }

    #[test]
    fn errored_when_the_rule_threw() {
        let out = report_json(&[("other-rule", 0)], &["folder-per-component"]);
        let d = drift_from_lint_meta("folder-per-component", FP, &out, None);
        assert_eq!(d.status, STATUS_ERRORED);
        assert_eq!(d.sites_matched, 0);
        assert_eq!(d.sites_checked, 0, "an errored record never claims a count");
        assert!(d.error_reason.unwrap().contains("threw"));
    }

    #[test]
    fn errored_when_output_is_unparseable() {
        let d = drift_from_lint_meta("folder-per-component", FP, "not json at all", None);
        assert_eq!(d.status, STATUS_ERRORED);
        assert!(d.error_reason.is_some());
    }

    #[test]
    fn errored_carries_the_run_error_when_the_process_failed() {
        // A spawn/timeout leaves empty stdout — the error reason must be the run failure,
        // never a misleading "not valid JSON".
        let d = drift_from_lint_meta("x", FP, "", Some("timed out after 300000ms"));
        assert_eq!(d.status, STATUS_ERRORED);
        assert_eq!(d.error_reason.as_deref(), Some("timed out after 300000ms"));
    }

    #[test]
    fn errored_when_no_rule_ran() {
        let d = drift_from_lint_meta("x", FP, &report_json(&[], &[]), None);
        assert_eq!(d.status, STATUS_ERRORED);
        assert!(d.error_reason.unwrap().contains("no lint-meta rules ran"));
    }

    #[test]
    fn extract_json_slices_past_a_banner_line() {
        let out = "$ bun run lint:meta --json\n{\"counts\":{\"r\":0},\"errored\":[],\"total\":0}\n";
        let d = drift_from_lint_meta("r", FP, out, None);
        assert_eq!(d.status, STATUS_CLEAN);
    }

    #[test]
    fn with_json_flag_is_idempotent() {
        assert_eq!(
            with_json_flag(&["run".into(), "lint:meta".into()]),
            vec!["run", "lint:meta", "--json"]
        );
        assert_eq!(
            with_json_flag(&["run".into(), "lint:meta".into(), "--json".into()]),
            vec!["run", "lint:meta", "--json"]
        );
    }

    /// A fake lint-meta runner: a script that echoes the given `--json` report body,
    /// so the EnforceRun wiring (load → run → capture → parse → join) is exercised
    /// end-to-end without needing bun / the real lint-meta CLI in the temp repo.
    #[cfg(unix)]
    fn fixture_repo(report_body: &str, manifest: &str) -> tempfile::TempDir {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = tmp.path().join("report.sh");
        std::fs::write(
            &script,
            format!("#!/bin/sh\ncat <<'EOF'\n{report_body}\nEOF\n"),
        )
        .expect("write script");
        let mut perms = std::fs::metadata(&script).expect("meta").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).expect("chmod");
        let nc = tmp.path().join(".nightcore");
        std::fs::create_dir_all(&nc).expect("mkdir .nightcore");
        std::fs::write(nc.join("harness.json"), manifest).expect("write manifest");
        tmp
    }

    #[cfg(unix)]
    #[test]
    fn run_with_drift_measures_a_lint_meta_check_end_to_end() {
        // An armed lint-meta check carrying a fingerprint → a `drifted` record with the
        // rule's site count, joined by fingerprint; the gate row runs + passes (the
        // `--json` reporter exits 0). The script path is absolute so it resolves
        // regardless of the child cwd.
        let tmp = fixture_repo(
            r#"{"violations":[],"counts":{"folder-per-component":2},"errored":[],"total":2}"#,
            "PLACEHOLDER",
        );
        let script = tmp.path().join("report.sh");
        let manifest = serde_json::json!({
            "checks": [{
                "name": "folder-per-component",
                "kind": "lint-meta",
                "command": script.to_string_lossy(),
                "enabled": true,
                "conventionFingerprint": FP,
            }]
        })
        .to_string();
        std::fs::write(tmp.path().join(".nightcore/harness.json"), manifest).expect("rewrite");

        let (result, drift) = run_with_drift(tmp.path(), tmp.path());
        assert_eq!(drift.len(), 1, "one armed drift check ⇒ one drift record");
        assert_eq!(drift[0].status, STATUS_DRIFTED);
        assert_eq!(drift[0].sites_matched, 2);
        assert_eq!(drift[0].convention_fingerprint, FP);
        assert_eq!(drift[0].method, "lint-meta: folder-per-component");
        // The gate result still carries the check row, and the measurement run passed.
        assert_eq!(result.checks.len(), 1);
        assert_eq!(result.checks[0].status, StepStatus::Passed);
    }

    #[cfg(unix)]
    #[test]
    fn a_lint_meta_check_without_a_fingerprint_emits_no_drift() {
        // No `conventionFingerprint` ⇒ nothing to join to ⇒ no drift record (it still
        // runs as an ordinary gate check).
        let tmp = fixture_repo(
            r#"{"violations":[],"counts":{"r":0},"errored":[],"total":0}"#,
            "PLACEHOLDER",
        );
        let script = tmp.path().join("report.sh");
        let manifest = serde_json::json!({
            "checks": [{
                "name": "r",
                "kind": "lint-meta",
                "command": script.to_string_lossy(),
                "enabled": true,
            }]
        })
        .to_string();
        std::fs::write(tmp.path().join(".nightcore/harness.json"), manifest).expect("rewrite");

        let (_result, drift) = run_with_drift(tmp.path(), tmp.path());
        assert!(drift.is_empty(), "no fingerprint ⇒ no drift record");
    }

    #[test]
    fn a_shell_check_is_skipped_so_it_never_runs_or_drifts() {
        // Drift-v1 shell execution is deferred: an armed shell check parses but
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
