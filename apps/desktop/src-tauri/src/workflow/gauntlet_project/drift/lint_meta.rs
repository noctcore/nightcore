//! The `lint-meta` drift substrate — the one Nightcore OWNS end to end.
//!
//! An armed `lint-meta` check is re-run with the machine-readable `--json` reporter
//! (`tools/lint-meta/json-reporter.ts`) and its per-rule `counts` are attributed
//! STRICTLY by rule id: a convention is measured only from its OWN rule, never inferred
//! from a sibling. A rule missing from the report DID NOT RUN, so it is `errored`
//! (fail-visible), never a `clean` borrowed from the rules that did.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

use super::super::config::PlannedCheck;
use super::capture::{extract_json, run_capture};
use super::record::{drift_id, errored_drift, STATUS_CLEAN, STATUS_DRIFTED};
use crate::store::types::{ConventionDrift, StepStatus, StructureLockCheck};

/// Run a lint-meta check with the `--json` reporter, capturing stdout, and turn the
/// report into a [`ConventionDrift`]. The gate row reflects whether the run itself
/// completed (a lint-meta `--json` run exits 0 by design; a spawn/timeout is `Failed`)
/// — the CONFORMANCE lives on the drift record, not the gate row.
pub(super) fn measure_lint_meta(
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
/// contract — extend additively only): per-rule `counts` (every rule that RAN, incl. 0)
/// and the `errored` rule ids (excluded from `counts`). We attribute STRICTLY per-rule
/// by name, so the report's suite `total` is deliberately not parsed — a convention is
/// measured only from its OWN rule's count (never inferred from siblings).
#[derive(Debug, Default, Deserialize)]
struct LintMetaReport {
    #[serde(default)]
    counts: BTreeMap<String, u64>,
    #[serde(default)]
    errored: Vec<String>,
}

/// Build a [`ConventionDrift`] from a lint-meta `--json` run. PURE (no I/O) so the
/// status mapping is unit-testable without spawning.
///
/// Attribution: a compiled lint-meta check's `name` is its rule id (synthesis names
/// the check after the rule, e.g. `folder-per-component`). `sitesMatched` is the
/// violating-site count; `sitesChecked` is a definitiveness lower-bound
/// (`≥ sitesMatched`, `≥1` once a rule ran) — lint-meta reports counts, not
/// files-scanned, so this is not a literal file total, but it is `>0` EXACTLY when a
/// definitive measurement exists, which is what the fail-visible product rule needs to
/// license `clean`.
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

    // This convention's rule MUST be present in `counts` — i.e. it actually RAN — before
    // any clean/drifted claim. Absent (empty registry, or a suite that ran OTHER rules)
    // ⇒ unmeasured ⇒ errored, never `clean` inferred from sibling rules. This is the
    // spec's non-negotiable "no `clean` without a real measurement of THIS convention".
    let Some(&matched) = report.counts.get(name) else {
        let reason = if report.counts.is_empty() {
            "no lint-meta rules ran, so drift could not be measured".to_string()
        } else {
            format!(
                "the lint-meta rule `{name}` was not in the report (it did not run), so this \
                 convention's conformance was not measured"
            )
        };
        return errored_drift(name, fingerprint, &method, reason);
    };
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

#[cfg(test)]
mod tests {
    use super::super::record::STATUS_ERRORED;
    use super::super::run_with_drift;
    use super::super::test_support::{fixture_repo, FP};
    use super::*;

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
    fn errored_when_this_conventions_rule_is_absent_from_the_report() {
        // The check's own rule never ran — sibling rules DID (some at 0). We must NOT
        // infer `clean` from the siblings: this convention's conformance is unmeasured.
        let out = report_json(&[("rule-a", 0), ("rule-b", 0)], &[]);
        let d = drift_from_lint_meta("folder-per-component", FP, &out, None);
        assert_eq!(
            d.status, STATUS_ERRORED,
            "absent rule ⇒ errored, never clean"
        );
        assert_eq!(d.sites_matched, 0);
        assert_eq!(d.sites_checked, 0);
        assert!(d.error_reason.unwrap().contains("did not run"));
    }

    #[test]
    fn errored_when_absent_even_though_siblings_drifted() {
        // Same absence, but siblings have violations — still errored (not `drifted`):
        // we never attribute another rule's count to this convention.
        let out = report_json(&[("rule-a", 7)], &[]);
        let d = drift_from_lint_meta("folder-per-component", FP, &out, None);
        assert_eq!(d.status, STATUS_ERRORED);
        assert_eq!(d.sites_matched, 0);
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

    #[cfg(unix)]
    #[test]
    fn run_with_drift_measures_a_lint_meta_check_end_to_end() {
        // An armed lint-meta check carrying a fingerprint → a `drifted` record with the
        // rule's site count, joined by fingerprint; the gate row runs + passes (the
        // `--json` reporter exits 0). The script path is absolute so it resolves
        // regardless of the child cwd.
        let tmp = fixture_repo(
            r#"{"violations":[],"counts":{"folder-per-component":2},"errored":[],"total":2}"#,
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
        let tmp = fixture_repo(r#"{"violations":[],"counts":{"r":0},"errored":[],"total":0}"#);
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
}
