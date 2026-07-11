//! Unit tests for the Structure-Lock Gauntlet, kept together so the config-parse,
//! full-run sequencing, worktree-parity, timeout, flaky-retry, and verify-command
//! cases share the `temp_project_with_config` fixtures.

use super::config::{is_armable_kind, load_checks, HarnessCheckKind, ARMABLE_CHECK_KINDS};
use super::runner::{
    append_task_verify_command, empty_pass, fix_instruction, run, run_from, VERIFY_COMMAND_CHECK,
};
use crate::store::types::{StepStatus, StructureLockCheck, StructureLockResult};

/// Write a `.nightcore/harness.json` with the given raw body into a fresh temp
/// dir and return the dir.
fn temp_project_with_config(body: &str) -> tempfile::TempDir {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let nc = tmp.path().join(".nightcore");
    std::fs::create_dir_all(&nc).expect("mkdir .nightcore");
    std::fs::write(nc.join("harness.json"), body).expect("write harness.json");
    tmp
}

/// Write an executable shell script into `dir` and return its absolute path — a
/// single-token command the whitespace-splitting planner can reference (the
/// manifest `command` has no shell quoting, so multi-word `sh -c '…'` scripts must
/// live in a file). Unix-only (the runner tests that need scripts are gated).
#[cfg(unix)]
fn write_script(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write script");
    let mut perms = std::fs::metadata(&path).expect("meta").permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).expect("chmod");
    path
}

#[test]
fn armable_kinds_are_exactly_the_runnable_kinds() {
    // The shared armable allowlist is the single source of truth for both the arm
    // command and the Checks Manager edit path; every entry must be a kind the
    // runner actually knows how to run (parse as a `HarnessCheckKind`), and the
    // helper agrees with the const.
    for kind in ARMABLE_CHECK_KINDS {
        assert!(is_armable_kind(kind), "{kind} must be armable");
        let parsed: Result<HarnessCheckKind, _> = serde_json::from_value(serde_json::json!(kind));
        assert!(
            parsed.is_ok(),
            "armable kind {kind} must be a runnable HarnessCheckKind"
        );
    }
    assert!(!is_armable_kind("shell"), "a stray kind is not armable");
    assert!(
        !is_armable_kind("Lint-Plugin"),
        "a case near-miss is not armable"
    );
}

#[test]
fn absent_config_skips_all_checks_and_passes() {
    // The pinning guarantee: a project with no .nightcore/harness.json is wholly
    // unaffected — the gate passes with zero checks.
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let result = run(tmp.path());
    assert!(result.passed, "absent config ⇒ pass");
    assert!(result.checks.is_empty());
    assert!(result.failed_check.is_none());
}

#[test]
fn malformed_config_warns_and_skips_all() {
    let tmp = temp_project_with_config("{ not json");
    let result = run(tmp.path());
    assert!(result.passed, "malformed config ⇒ skip all ⇒ pass");
    assert!(result.checks.is_empty());
}

#[test]
fn missing_checks_array_skips_all() {
    let tmp = temp_project_with_config(r#"{ "other": true }"#);
    let result = run(tmp.path());
    assert!(result.passed);
    assert!(result.checks.is_empty());
}

#[test]
fn config_parses_kinds_and_default_enabled() {
    // Three well-formed entries parse; an entry with no `enabled` defaults on; a
    // disabled entry is dropped from the plan.
    let body = r#"{
        "checks": [
            { "name": "lint", "kind": "lint-plugin", "command": "sh -c true" },
            { "name": "arch", "kind": "dependency-cruiser", "command": "sh -c true", "enabled": true },
            { "name": "cov", "kind": "coverage-threshold", "command": "sh -c true", "enabled": false }
        ]
    }"#;
    let tmp = temp_project_with_config(body);
    let planned = load_checks(tmp.path());
    let names: Vec<&str> = planned.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["lint", "arch"], "the disabled check is dropped");
    assert_eq!(planned[0].kind.as_wire(), "lint-plugin");
    assert_eq!(planned[1].kind.as_wire(), "dependency-cruiser");
}

#[test]
fn config_parses_the_armable_future_kinds() {
    // The four kinds added for the hardening catalog are RUNNABLE from a
    // manifest entry: they parse kebab-case and round-trip to the same wire
    // string a `StructureLockCheck` will carry (arm-time allowlisting of what
    // a proposal may WRITE is a separate gate, not this parser's job).
    let body = r#"{
        "checks": [
            { "name": "lock", "kind": "lockfile-lint", "command": "sh -c true" },
            { "name": "env", "kind": "env-contract", "command": "sh -c true" },
            { "name": "sec", "kind": "secret-scan", "command": "sh -c true" },
            { "name": "mut", "kind": "mutation-score", "command": "sh -c true" }
        ]
    }"#;
    let tmp = temp_project_with_config(body);
    let planned = load_checks(tmp.path());
    let wires: Vec<&str> = planned.iter().map(|p| p.kind.as_wire()).collect();
    assert_eq!(
        wires,
        vec![
            "lockfile-lint",
            "env-contract",
            "secret-scan",
            "mutation-score"
        ],
        "every new kind parses and reports its stable wire string"
    );
}

#[test]
fn config_parses_the_ast_grep_and_api_extractor_kinds() {
    // The two #18 producers (ast-grep policy pack, api-extractor surface lock) are
    // RUNNABLE from a manifest entry: kebab-case parse + stable wire round-trip,
    // exactly like the seven kinds before them.
    let body = r#"{
        "checks": [
            { "name": "policy", "kind": "ast-grep", "command": "sh -c true" },
            { "name": "surface", "kind": "api-extractor", "command": "sh -c true" }
        ]
    }"#;
    let tmp = temp_project_with_config(body);
    let planned = load_checks(tmp.path());
    let wires: Vec<&str> = planned.iter().map(|p| p.kind.as_wire()).collect();
    assert_eq!(
        wires,
        vec!["ast-grep", "api-extractor"],
        "both new kinds parse and report their stable wire strings"
    );
}

#[test]
fn malformed_entry_is_skipped_but_siblings_run() {
    // The first entry is missing `kind` (malformed) — warn-and-skip it; the
    // second still plans.
    let body = r#"{
        "checks": [
            { "name": "broken", "command": "sh -c true" },
            { "name": "ok", "kind": "lint-plugin", "command": "sh -c true" }
        ]
    }"#;
    let tmp = temp_project_with_config(body);
    let planned = load_checks(tmp.path());
    let names: Vec<&str> = planned.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["ok"], "only the well-formed entry survives");
}

#[test]
fn an_entry_with_no_command_is_skipped() {
    let body = r#"{
        "checks": [
            { "name": "nocmd", "kind": "lint-plugin" },
            { "name": "ok", "kind": "lint-plugin", "command": "sh -c true" }
        ]
    }"#;
    let tmp = temp_project_with_config(body);
    let planned = load_checks(tmp.path());
    let names: Vec<&str> = planned.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["ok"], "a command-less check can't run");
}

#[cfg(unix)]
#[test]
fn a_passing_check_set_passes_and_records_duration() {
    // Two passing checks over the real runner: the gate is green and each check
    // records a duration (per-check duration telemetry).
    let tmp = temp_project_with_config(
        r#"{ "checks": [
            { "name": "lint", "kind": "lint-plugin", "command": "sh -c true" },
            { "name": "arch", "kind": "dependency-cruiser", "command": "sh -c true" }
        ] }"#,
    );
    let result = run(tmp.path());
    assert!(result.passed);
    assert!(result.checks.iter().all(|c| c.status == StepStatus::Passed));
    assert!(result.failed_check.is_none());
    assert!(
        result.checks.iter().all(|c| c.duration_ms.is_some()),
        "every check records its wall-clock duration"
    );
}

#[cfg(unix)]
#[test]
fn full_run_records_every_failure_and_does_not_stop_at_first() {
    // Full-run mode: a failing check does NOT skip its siblings — every check runs
    // and records its own outcome, so one fix session sees the whole set.
    let tmp = temp_project_with_config(
        r#"{ "checks": [
            { "name": "lint", "kind": "lint-plugin", "command": "false" },
            { "name": "arch", "kind": "dependency-cruiser", "command": "false" },
            { "name": "cov", "kind": "coverage-threshold", "command": "sh -c true" }
        ] }"#,
    );
    let result = run(tmp.path());
    assert!(!result.passed);
    // `failed_check` names the FIRST failure (back-compat for fix-routing).
    assert_eq!(result.failed_check.as_deref(), Some("lint"));
    // No check is `Skipped` — the sibling after the first failure still ran.
    assert!(
        result
            .checks
            .iter()
            .all(|c| c.status != StepStatus::Skipped),
        "full-run never skips"
    );
    let by = |n: &str| result.checks.iter().find(|c| c.name == n).unwrap().status;
    assert_eq!(by("lint"), StepStatus::Failed);
    assert_eq!(by("arch"), StepStatus::Failed, "the second failure ran too");
    assert_eq!(by("cov"), StepStatus::Passed);

    // The aggregate fix instruction lists BOTH failing checks (the whole set).
    let fix = fix_instruction(&result);
    assert!(
        fix.contains("lint") && fix.contains("arch"),
        "aggregates all failures: {fix}"
    );
    assert!(
        !fix.contains("\ncov"),
        "a passing check is not in the fix set"
    );
}

#[cfg(unix)]
#[test]
fn a_flaky_check_fails_then_passes_and_is_not_a_failure() {
    // Retry-once: a check that fails on its first run but passes on the retry is
    // `Flaky` — a non-failure the gate ignores, so a flake no longer burns a fix
    // session. The script toggles on a marker file it creates in the run dir.
    let tmp = temp_project_with_config("{}"); // config written below with the abs path
    let script = write_script(
        tmp.path(),
        "flaky.sh",
        "if [ -f flaky-marker ]; then exit 0; else touch flaky-marker; exit 1; fi",
    );
    std::fs::write(
        tmp.path().join(".nightcore/harness.json"),
        format!(
            r#"{{ "checks": [ {{ "name": "flake", "kind": "lint-plugin", "command": "{}" }} ] }}"#,
            script.display()
        ),
    )
    .expect("rewrite manifest");

    let result = run(tmp.path());
    assert!(result.passed, "a flaky check does not fail the gate");
    assert!(result.failed_check.is_none());
    assert_eq!(result.checks.len(), 1);
    assert_eq!(result.checks[0].status, StepStatus::Flaky);
    assert!(
        result.checks[0]
            .output
            .as_deref()
            .unwrap_or_default()
            .contains("flaky"),
        "the flaky note is surfaced"
    );
    // `fix_instruction` ignores a flake (it passed on retry).
    assert!(!fix_instruction(&result).contains("flake"));
}

#[test]
fn security_critical_kinds_are_secret_scan_and_mutation_score() {
    // The greppable classification that drives the flaky-retry exclusion: only the
    // two security kinds are security-critical; every other runnable kind is not.
    use HarnessCheckKind::*;
    assert!(SecretScan.is_security_critical());
    assert!(MutationScore.is_security_critical());
    for kind in [
        LintPlugin,
        DependencyCruiser,
        CoverageThreshold,
        LockfileLint,
        EnvContract,
        AstGrep,
        ApiExtractor,
    ] {
        assert!(
            !kind.is_security_critical(),
            "{kind:?} must not be security-critical"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_security_check_that_fails_then_passes_is_not_a_flaky_pass() {
    // Item 3: security-critical kinds are EXCLUDED from flaky-retry. The very same
    // fail-then-pass script that a `lint-plugin` treats as non-blocking `flaky`
    // (see `a_flaky_check_fails_then_passes_and_is_not_a_failure`) must BLOCK for a
    // security kind — with no retry, the first failure is the verdict.
    for kind in ["secret-scan", "mutation-score"] {
        let tmp = temp_project_with_config("{}"); // config rewritten below with the abs path
        let script = write_script(
            tmp.path(),
            "flaky.sh",
            "if [ -f flaky-marker ]; then exit 0; else touch flaky-marker; exit 1; fi",
        );
        std::fs::write(
            tmp.path().join(".nightcore/harness.json"),
            format!(
                r#"{{ "checks": [ {{ "name": "sec", "kind": "{kind}", "command": "{}" }} ] }}"#,
                script.display()
            ),
        )
        .expect("rewrite manifest");

        let result = run(tmp.path());
        assert!(
            !result.passed,
            "{kind} must block on a fail-then-pass, not flip to a flaky pass"
        );
        assert_eq!(result.failed_check.as_deref(), Some("sec"), "{kind}");
        assert_eq!(result.checks[0].status, StepStatus::Failed, "{kind}");
    }
}

#[cfg(unix)]
#[test]
fn a_non_security_check_still_gets_its_one_flaky_retry() {
    // The contrast: a non-security kind keeps the single retry, so the identical
    // fail-then-pass script is `Flaky` (non-blocking) — the retry is not removed
    // wholesale, only for security-critical kinds.
    let tmp = temp_project_with_config("{}");
    let script = write_script(
        tmp.path(),
        "flaky.sh",
        "if [ -f flaky-marker ]; then exit 0; else touch flaky-marker; exit 1; fi",
    );
    std::fs::write(
        tmp.path().join(".nightcore/harness.json"),
        format!(
            r#"{{ "checks": [ {{ "name": "cov", "kind": "coverage-threshold", "command": "{}" }} ] }}"#,
            script.display()
        ),
    )
    .expect("rewrite manifest");

    let result = run(tmp.path());
    assert!(result.passed, "a non-security flake does not fail the gate");
    assert!(result.failed_check.is_none());
    assert_eq!(result.checks[0].status, StepStatus::Flaky);
}

#[cfg(unix)]
#[test]
fn a_hung_check_times_out_and_fails_closed() {
    // A check that overruns its `timeoutMs` is killed and recorded as a FAILURE —
    // never a silent pass, and never an unbounded block on verification.
    let tmp = temp_project_with_config(
        r#"{ "checks": [
            { "name": "hang", "kind": "lint-plugin", "command": "sleep 30", "timeoutMs": 150 }
        ] }"#,
    );
    let start = std::time::Instant::now();
    let result = run(tmp.path());
    // Retried once → ~2 * 150ms, plus spawn overhead. Comfortably under the 30s sleep.
    assert!(
        start.elapsed() < std::time::Duration::from_secs(10),
        "the hung check is killed promptly, not waited out"
    );
    assert!(!result.passed, "a timeout fails the gate (fail-closed)");
    assert_eq!(result.failed_check.as_deref(), Some("hang"));
    assert_eq!(result.checks[0].status, StepStatus::Failed);
    assert!(
        result.checks[0]
            .output
            .as_deref()
            .unwrap_or_default()
            .contains("timed out"),
        "the timeout is reported"
    );
}

#[cfg(unix)]
#[test]
fn a_failing_check_is_retried_before_being_marked_failed() {
    // A check that fails BOTH times is a genuine failure carrying the retry's output.
    let tmp = temp_project_with_config(
        r#"{ "checks": [
            { "name": "surface", "kind": "api-extractor", "command": "false" }
        ] }"#,
    );
    let result = run(tmp.path());
    assert!(!result.passed);
    assert_eq!(result.checks[0].status, StepStatus::Failed);
    assert_eq!(result.checks[0].kind, "api-extractor");
    assert!(result.checks[0].duration_ms.is_some());
}

#[test]
fn fix_instruction_names_the_failed_check_and_command() {
    let result = StructureLockResult {
        passed: false,
        failed_check: Some("folder-per-component".into()),
        checks: vec![StructureLockCheck {
            name: "folder-per-component".into(),
            kind: "lint-plugin".into(),
            command: "npx eslint .".into(),
            status: StepStatus::Failed,
            exit_code: Some(1),
            output: Some("error: missing index".into()),
            duration_ms: Some(42),
        }],
    };
    let text = fix_instruction(&result);
    assert!(text.contains("folder-per-component"), "names the check");
    assert!(text.contains("npx eslint ."), "includes the command");
    assert!(text.contains("missing index"), "includes the output");
}

#[test]
fn empty_pass_is_trivially_passing() {
    let r = empty_pass();
    assert!(r.passed && r.checks.is_empty() && r.failed_check.is_none());
}

/// Worktree-parity regression (the gauntlet manifest gap): the manifest is
/// loaded from the PROJECT root while the checks RUN in the review dir. A
/// worktree has no `.nightcore/` (gitignored), so the old `run(review_dir)`
/// silently skipped every project check.
#[cfg(unix)]
#[test]
fn run_from_reads_the_root_manifest_but_runs_in_the_review_dir() {
    // The check passes ONLY when executed in the review dir: the marker file
    // exists there and deliberately NOT in the project root.
    let project = temp_project_with_config(
        r#"{ "checks": [
            { "name": "marker", "kind": "lint-plugin", "command": "test -f review-marker.txt" }
        ] }"#,
    );
    let review = tempfile::TempDir::new().expect("review dir");
    std::fs::write(review.path().join("review-marker.txt"), "x").expect("write marker");

    // The old bug shape: running over the manifest-less review dir skips all.
    let skipped = run(review.path());
    assert!(
        skipped.passed && skipped.checks.is_empty(),
        "no manifest ⇒ silent skip"
    );

    // The fix: manifest from the root, execution in the review dir.
    let result = run_from(project.path(), review.path());
    assert_eq!(result.checks.len(), 1, "the root manifest's check ran");
    assert_eq!(result.checks[0].status, StepStatus::Passed);
    assert!(result.passed);

    // Cross-check the cwd claim: the same call rooted AT the project (which
    // lacks the marker) fails — proving the check really ran in `run_dir`.
    let at_root = run_from(project.path(), project.path());
    assert!(!at_root.passed, "the marker only exists in the review dir");
    assert_eq!(at_root.checks[0].status, StepStatus::Failed);
}

#[test]
fn run_is_the_manifest_root_eq_run_dir_case() {
    // Main-mode pinning: `run(dir)` must stay byte-identical to
    // `run_from(dir, dir)` — absent config passes trivially through both.
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let a = run(tmp.path());
    let b = run_from(tmp.path(), tmp.path());
    assert!(a.passed && b.passed);
    assert_eq!(a.checks.len(), b.checks.len());
}

#[cfg(unix)]
#[test]
fn task_verify_command_appends_a_passing_check() {
    // A whitespace-split command (like `npx eslint .` in production) — no shell
    // quoting, matching the planner. `sh -c true` runs the `true` builtin → exit 0.
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let mut result = empty_pass();
    append_task_verify_command(&mut result, "sh -c true", tmp.path());
    assert!(
        result.passed,
        "a passing verify command keeps the gate green"
    );
    assert_eq!(result.checks.len(), 1);
    assert_eq!(result.checks[0].name, VERIFY_COMMAND_CHECK);
    assert_eq!(result.checks[0].kind, VERIFY_COMMAND_CHECK);
    assert_eq!(result.checks[0].status, StepStatus::Passed);
    assert!(result.checks[0].duration_ms.is_some());
    assert!(result.failed_check.is_none());
}

#[cfg(unix)]
#[test]
fn task_verify_command_failure_flips_the_gate_and_captures_output() {
    // `ls <missing>` fails with stderr and a non-zero exit — whitespace-safe, no shell.
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let mut result = empty_pass();
    append_task_verify_command(&mut result, "ls /no-such-path-nc-xyz", tmp.path());
    assert!(!result.passed, "a failing verify command fails the gate");
    assert_eq!(result.failed_check.as_deref(), Some(VERIFY_COMMAND_CHECK));
    let check = &result.checks[0];
    assert_eq!(check.status, StepStatus::Failed);
    assert!(
        check
            .output
            .as_deref()
            .unwrap()
            .contains("no-such-path-nc-xyz"),
        "captures output for the fix loop"
    );
    // The fix instruction the auto-fix loop feeds back names it + its command.
    let fix = fix_instruction(&result);
    assert!(fix.contains(VERIFY_COMMAND_CHECK) && fix.contains("ls /no-such-path-nc-xyz"));
}

#[test]
fn task_verify_command_blank_is_a_noop() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let mut result = empty_pass();
    append_task_verify_command(&mut result, "   ", tmp.path());
    assert!(
        result.passed && result.checks.is_empty(),
        "a blank command adds nothing"
    );
}

#[test]
fn result_serializes_camel_case_and_omits_absent_failed_check() {
    let r = empty_pass();
    let value = serde_json::to_value(&r).unwrap();
    let obj = value.as_object().unwrap();
    assert!(obj.contains_key("passed"));
    assert!(obj.contains_key("checks"));
    // `failed_check` is omitted when None (skip_serializing_if), matching the
    // gauntlet's `failedStep?` optionality.
    assert!(
        !obj.contains_key("failedCheck"),
        "absent failed_check is omitted, not null"
    );
}
