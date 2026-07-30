//! The `eslint-rule` drift substrate (Drift-v2, #279) — the generated-rule fast-follow
//! the drift v1 spec gated on #185/#194's RuleTester runner.
//!
//! An armed `eslint-rule` check runs the target repo's OWN ESLint (through a package
//! script — see `super::super::command_guard`) with `--format json --stats` appended.
//!
//! `--stats` is the load-bearing flag. ESLint's JSON report lists MESSAGES, so "no
//! messages for this rule" is ambiguous between *the rule ran and the repo conforms* and
//! *the rule was never enabled in this repo's config*. `--stats` adds a per-file
//! `stats.times.passes[].rules` map naming every rule that ACTUALLY RAN, which turns the
//! ambiguity into two distinguishable outcomes: a real `clean` with a real files-checked
//! denominator, or `errored` ("the rule is not enabled"). Without it this substrate could
//! only ever be a placebo gate.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

use super::super::config::PlannedCheck;
use super::capture::{extract_json_array, run_capture};
use super::record::{drift_id, errored_drift, STATUS_CLEAN, STATUS_DRIFTED, STATUS_ERRORED};
use crate::store::types::{ConventionDrift, StepStatus, StructureLockCheck};

/// The flags that make an ESLint run MEASURABLE: `--format json` for machine-readable
/// results and `--stats` for the per-file rules map that PROVES which rules ran.
const ESLINT_MEASURE_FLAGS: &[&str] = &["--format", "json", "--stats"];

/// Run a compiled ESLint-rule check with the measurement flags and turn its report into
/// a [`ConventionDrift`]. The gate row reflects whether a DEFINITIVE measurement came
/// back — an ESLint run exits 1 whenever any rule reports, which is the normal
/// `drifted` case, so the exit code alone can never decide it.
pub(super) fn measure_eslint_rule(
    check: &PlannedCheck,
    run_dir: &Path,
    fingerprint: &str,
) -> (StructureLockCheck, ConventionDrift) {
    let args = with_eslint_flags(&check.args);
    let cap = run_capture(&check.program, &args, run_dir, check.timeout);

    let drift = drift_from_eslint(
        &check.name,
        fingerprint,
        &cap.stdout,
        cap.run_error.as_deref(),
    );

    // A measurement landed (clean/drifted) ⇒ the check RAN, regardless of ESLint's exit
    // code. Only an `errored` drift means the run itself could not measure anything.
    let status = if drift.status == STATUS_ERRORED {
        StepStatus::Failed
    } else {
        StepStatus::Passed
    };
    let sl = StructureLockCheck {
        name: check.name.clone(),
        kind: check.kind.as_wire().to_string(),
        command: check.command.clone(),
        status,
        exit_code: cap.exit_code,
        output: if status == StepStatus::Failed {
            cap.run_error.clone()
        } else {
            None
        },
        duration_ms: Some(cap.duration_ms),
    };
    (sl, drift)
}

/// Append the measurement flags to a `<pm> run <script>` invocation. A package manager
/// needs a `--` separator before flags meant for the SCRIPT rather than the manager
/// itself, so one is inserted when absent. Idempotent: a flag the command already
/// declares is left alone (never duplicated).
fn with_eslint_flags(args: &[String]) -> Vec<String> {
    let mut out = args.to_vec();
    if !out.iter().any(|a| a == "--") {
        out.push("--".to_string());
    }
    let mut it = ESLINT_MEASURE_FLAGS.iter().peekable();
    while let Some(flag) = it.next() {
        // A value token is any following entry that is not itself a flag.
        let value = it.peek().filter(|v| !v.starts_with("--")).copied();
        if value.is_some() {
            it.next();
        }
        if out.iter().any(|a| a == flag) {
            continue;
        }
        out.push((*flag).to_string());
        if let Some(v) = value {
            out.push(v.to_string());
        }
    }
    out
}

/// One file entry of ESLint's `json` formatter (a subset — extend additively only).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EslintFileResult {
    #[serde(default)]
    messages: Vec<EslintMessage>,
    /// Present only with `--stats`; absent ⇒ we cannot prove which rules ran.
    #[serde(default)]
    stats: Option<EslintStats>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EslintMessage {
    /// `null` for a fatal parse error (which belongs to no rule).
    #[serde(default)]
    rule_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct EslintStats {
    #[serde(default)]
    times: Option<EslintTimes>,
}

#[derive(Debug, Default, Deserialize)]
struct EslintTimes {
    #[serde(default)]
    passes: Vec<EslintPass>,
}

#[derive(Debug, Default, Deserialize)]
struct EslintPass {
    /// Every rule that RAN on this file, keyed by rule id (the values are timings we
    /// deliberately ignore — only membership is load-bearing).
    #[serde(default)]
    rules: BTreeMap<String, serde_json::Value>,
}

impl EslintFileResult {
    /// Whether `rule_id` actually ran on this file (per `--stats`). `None` ⇒ the run
    /// carried no stats at all, so nothing can be concluded.
    fn ran_rule(&self, rule_id: &str) -> Option<bool> {
        let passes = &self.stats.as_ref()?.times.as_ref()?.passes;
        Some(passes.iter().any(|p| p.rules.contains_key(rule_id)))
    }

    /// How many messages on this file this rule reported.
    fn messages_for(&self, rule_id: &str) -> u64 {
        self.messages
            .iter()
            .filter(|m| m.rule_id.as_deref() == Some(rule_id))
            .count() as u64
    }
}

/// Build a [`ConventionDrift`] from an ESLint `--format json --stats` run. PURE (no I/O)
/// so the fail-visible status mapping is unit-testable without spawning ESLint.
///
/// Attribution is strictly per-rule: a compiled check's `name` IS the rule id, and only
/// messages carrying that `ruleId` count. `sitesChecked` is the number of files the rule
/// DEMONSTRABLY ran on (from `--stats`), so it is a real denominator rather than a
/// lower-bound — and it is `0` exactly when the rule is not wired into the repo's config,
/// which yields `errored`, never a placebo `clean`.
fn drift_from_eslint(
    name: &str,
    fingerprint: &str,
    stdout: &str,
    run_error: Option<&str>,
) -> ConventionDrift {
    let method = format!("eslint: {name}");

    let Some(results) = extract_json_array(stdout)
        .and_then(|j| serde_json::from_str::<Vec<EslintFileResult>>(j).ok())
    else {
        let reason = run_error
            .map(str::to_string)
            .unwrap_or_else(|| "ESLint `--format json` output was not valid JSON".to_string());
        return errored_drift(name, fingerprint, &method, reason);
    };

    if results.is_empty() {
        return errored_drift(
            name,
            fingerprint,
            &method,
            "ESLint linted no files, so this convention's conformance was not measured".to_string(),
        );
    }

    // `--stats` is the proof-of-execution signal. If NO result carries stats the ESLint
    // in this repo did not emit them (too old, or a formatter that drops them) — we
    // cannot tell "clean" from "never ran", so this is fail-visible.
    if results.iter().all(|r| r.ran_rule(name).is_none()) {
        return errored_drift(
            name,
            fingerprint,
            &method,
            format!(
                "ESLint reported no per-rule `--stats`, so we cannot prove the rule `{name}` ran \
                 — conformance was not measured (needs an ESLint that supports `--stats`)"
            ),
        );
    }

    let checked = results
        .iter()
        .filter(|r| r.ran_rule(name) == Some(true))
        .count() as u64;
    if checked == 0 {
        return errored_drift(
            name,
            fingerprint,
            &method,
            format!(
                "the ESLint rule `{name}` did not run on any linted file — it is not enabled in \
                 this repo's ESLint config, so this convention's conformance was not measured"
            ),
        );
    }

    let matched: u64 = results.iter().map(|r| r.messages_for(name)).sum();
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
    use super::super::run_with_drift;
    use super::super::test_support::{fixture_repo, FP};
    use super::*;

    const RULE: &str = "local/folder-per-component";

    /// An ESLint `--format json --stats` payload: one entry per file, each declaring the
    /// rules that ran on it and the messages it reported.
    fn eslint_json(files: &[(&[&str], &[&str])]) -> String {
        let results: Vec<serde_json::Value> = files
            .iter()
            .enumerate()
            .map(|(i, (ran, reported))| {
                let rules: serde_json::Map<String, serde_json::Value> = ran
                    .iter()
                    .map(|r| ((*r).to_string(), serde_json::json!({ "total": 0.1 })))
                    .collect();
                serde_json::json!({
                    "filePath": format!("/repo/src/f{i}.ts"),
                    "messages": reported
                        .iter()
                        .map(|r| serde_json::json!({ "ruleId": r, "severity": 2 }))
                        .collect::<Vec<_>>(),
                    "errorCount": reported.len(),
                    "stats": { "times": { "passes": [{ "rules": rules }] } },
                })
            })
            .collect();
        serde_json::Value::Array(results).to_string()
    }

    #[test]
    fn clean_counts_the_files_the_rule_demonstrably_ran_on() {
        // The rule ran on 3 files and reported nothing ⇒ a REAL clean with a real
        // denominator (unlike lint-meta, `--stats` gives a literal files-checked count).
        let out = eslint_json(&[
            (&[RULE, "no-debugger"], &[]),
            (&[RULE], &[]),
            (&[RULE], &[]),
        ]);
        let d = drift_from_eslint(RULE, FP, &out, None);
        assert_eq!(d.status, STATUS_CLEAN);
        assert_eq!(d.sites_matched, 0);
        assert_eq!(d.sites_checked, 3);
        assert_eq!(d.method, "eslint: local/folder-per-component");
        assert_eq!(d.id, "drift-a1b2c3d4e5f60718");
        assert!(d.error_reason.is_none());
    }

    #[test]
    fn drifted_attributes_only_this_rules_messages() {
        // 2 violations from THIS rule; a sibling rule's 3 must not bleed in. Files the
        // rule did not run on (entry 3) are excluded from the denominator.
        let out = eslint_json(&[
            (&[RULE], &[RULE, "no-debugger"]),
            (&[RULE], &[RULE, "no-debugger", "no-debugger"]),
            (&["no-debugger"], &["no-debugger"]),
        ]);
        let d = drift_from_eslint(RULE, FP, &out, None);
        assert_eq!(d.status, STATUS_DRIFTED);
        assert_eq!(d.sites_matched, 2);
        assert_eq!(d.sites_checked, 2);
    }

    #[test]
    fn errored_when_the_rule_is_not_wired_into_the_config() {
        // THE placebo-gate case: ESLint ran fine and reported nothing for this rule —
        // but `--stats` proves the rule never ran. That MUST be errored, not `clean`.
        let out = eslint_json(&[(&["no-debugger"], &[]), (&["no-debugger"], &[])]);
        let d = drift_from_eslint(RULE, FP, &out, None);
        assert_eq!(
            d.status, STATUS_ERRORED,
            "unwired rule ⇒ errored, never clean"
        );
        assert_eq!(d.sites_checked, 0);
        assert!(d.error_reason.unwrap().contains("not enabled"));
    }

    #[test]
    fn errored_when_the_run_carried_no_stats() {
        // No `--stats` support ⇒ "0 messages" is ambiguous ⇒ never `clean`.
        let out = r#"[{"filePath":"/repo/a.ts","messages":[],"errorCount":0}]"#;
        let d = drift_from_eslint(RULE, FP, out, None);
        assert_eq!(d.status, STATUS_ERRORED);
        assert_eq!(d.sites_checked, 0);
        assert!(d.error_reason.unwrap().contains("`--stats`"));
    }

    #[test]
    fn errored_when_no_files_were_linted_or_output_is_unparseable() {
        let empty = drift_from_eslint(RULE, FP, "[]", None);
        assert_eq!(empty.status, STATUS_ERRORED);
        assert!(empty.error_reason.unwrap().contains("linted no files"));

        let junk = drift_from_eslint(RULE, FP, "eslint exploded", Some("exit 2: config error"));
        assert_eq!(junk.status, STATUS_ERRORED);
        // The run failure is the honest reason — never a misleading "not valid JSON".
        assert_eq!(junk.error_reason.as_deref(), Some("exit 2: config error"));
    }

    #[test]
    fn measures_through_a_banner_line_and_a_nonzero_exit() {
        // ESLint exits 1 whenever any rule reports — the NORMAL `drifted` case. A
        // non-zero exit (surfaced as `run_error`) must not mask a parseable report.
        let body = eslint_json(&[(&[RULE], &[RULE])]);
        let out = format!("$ bun run lint -- --format json --stats\n{body}\n");
        let d = drift_from_eslint(RULE, FP, &out, Some("exit code 1"));
        assert_eq!(d.status, STATUS_DRIFTED);
        assert_eq!(d.sites_matched, 1);
        assert_eq!(d.sites_checked, 1);
    }

    #[test]
    fn with_eslint_flags_inserts_a_separator_once_and_is_idempotent() {
        assert_eq!(
            with_eslint_flags(&["run".into(), "lint".into()]),
            vec!["run", "lint", "--", "--format", "json", "--stats"]
        );
        // Already fully specified ⇒ untouched (no duplicate `--`/flags).
        let full: Vec<String> = ["run", "lint", "--", "--format", "json", "--stats"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(with_eslint_flags(&full), full);
    }

    #[cfg(unix)]
    #[test]
    fn run_with_drift_measures_an_eslint_rule_check_end_to_end() {
        let body = eslint_json(&[(&[RULE], &[RULE, RULE]), (&[RULE], &[])]);
        let tmp = fixture_repo(&body);
        let script = tmp.path().join("report.sh");
        let manifest = serde_json::json!({
            "checks": [{
                "name": RULE,
                "kind": "eslint-rule",
                "command": script.to_string_lossy(),
                "enabled": true,
                "conventionFingerprint": FP,
            }]
        })
        .to_string();
        std::fs::write(tmp.path().join(".nightcore/harness.json"), manifest).expect("rewrite");

        let (result, drift) = run_with_drift(tmp.path(), tmp.path());
        assert_eq!(drift.len(), 1);
        assert_eq!(drift[0].status, STATUS_DRIFTED);
        assert_eq!(drift[0].sites_matched, 2);
        assert_eq!(drift[0].sites_checked, 2);
        assert_eq!(drift[0].method, "eslint: local/folder-per-component");
        assert_eq!(result.checks.len(), 1);
        assert_eq!(result.checks[0].status, StepStatus::Passed);
        assert_eq!(result.checks[0].kind, "eslint-rule");
    }
}
