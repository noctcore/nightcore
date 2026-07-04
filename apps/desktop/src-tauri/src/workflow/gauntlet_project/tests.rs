//! Unit tests for the Structure-Lock Gauntlet, kept together so the config-parse,
//! sequencing, worktree-parity, and verify-command cases share the
//! `temp_project_with_config` / `run_planned` fixtures.

use std::path::Path;
use std::process::Command;

use super::config::{load_checks, HarnessCheckKind, PlannedCheck};
use super::runner::{
    append_task_verify_command, empty_pass, fix_instruction, run, run_from, VERIFY_COMMAND_CHECK,
};
use crate::gauntlet::tail_output;
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

/// Mirror `run()` over hand-built plans through `sh` directly, so the test does
/// not depend on the platform resolver or a real tool being installed. Exercises
/// the same sequencing + stop-at-first logic.
fn run_planned(planned: Vec<PlannedCheck>, dir: &Path) -> StructureLockResult {
    let mut checks = Vec::new();
    let mut failed: Option<String> = None;
    for check in planned {
        let kind = check.kind.as_wire().to_string();
        if failed.is_some() {
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
        let output = Command::new(&check.program)
            .args(&check.args)
            .current_dir(dir)
            .output()
            .expect("spawn sh");
        if output.status.success() {
            checks.push(StructureLockCheck {
                name: check.name,
                kind,
                command: check.command,
                status: StepStatus::Passed,
                exit_code: output.status.code(),
                output: None,
            });
        } else {
            failed = Some(check.name.clone());
            checks.push(StructureLockCheck {
                name: check.name,
                kind,
                command: check.command,
                status: StepStatus::Failed,
                exit_code: output.status.code(),
                output: Some(tail_output(&output.stdout, &output.stderr)),
            });
        }
    }
    StructureLockResult {
        passed: failed.is_none(),
        checks,
        failed_check: failed,
    }
}

fn sh_check(name: &str, kind: HarnessCheckKind, script: &str) -> PlannedCheck {
    PlannedCheck {
        name: name.to_string(),
        kind,
        command: format!("sh -c {script}"),
        program: "sh".to_string(),
        args: vec!["-c".to_string(), script.to_string()],
    }
}

#[test]
fn a_passing_check_set_passes() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let result = run_planned(
        vec![
            sh_check("lint", HarnessCheckKind::LintPlugin, "exit 0"),
            sh_check("arch", HarnessCheckKind::DependencyCruiser, "exit 0"),
        ],
        tmp.path(),
    );
    assert!(result.passed);
    assert!(result.checks.iter().all(|c| c.status == StepStatus::Passed));
    assert!(result.failed_check.is_none());
}

#[test]
fn a_failing_check_stops_the_run_and_reports_it() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let result = run_planned(
        vec![
            sh_check(
                "lint",
                HarnessCheckKind::LintPlugin,
                "echo boom 1>&2; exit 1",
            ),
            sh_check("arch", HarnessCheckKind::DependencyCruiser, "exit 0"),
        ],
        tmp.path(),
    );
    assert!(!result.passed);
    assert_eq!(result.failed_check.as_deref(), Some("lint"));
    let lint = result.checks.iter().find(|c| c.name == "lint").unwrap();
    assert_eq!(lint.status, StepStatus::Failed);
    assert!(lint.output.as_deref().unwrap().contains("boom"));
    // Everything after a failure is skipped (stop-at-first).
    let arch = result.checks.iter().find(|c| c.name == "arch").unwrap();
    assert_eq!(arch.status, StepStatus::Skipped);
}

#[test]
fn ast_grep_and_api_extractor_checks_run_like_any_other() {
    // The runner arm for the two new kinds: a passing ast-grep check runs, a failing
    // api-extractor check (an out-of-date API report exits non-zero) stops the gate
    // and carries its wire kind onto the result.
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let result = run_planned(
        vec![
            sh_check("policy", HarnessCheckKind::AstGrep, "exit 0"),
            sh_check(
                "surface",
                HarnessCheckKind::ApiExtractor,
                "echo drift 1>&2; exit 1",
            ),
        ],
        tmp.path(),
    );
    assert!(!result.passed);
    assert_eq!(result.failed_check.as_deref(), Some("surface"));
    assert_eq!(result.checks[0].status, StepStatus::Passed);
    assert_eq!(result.checks[0].kind, "ast-grep");
    assert_eq!(result.checks[1].status, StepStatus::Failed);
    assert_eq!(result.checks[1].kind, "api-extractor");
    assert!(result.checks[1]
        .output
        .as_deref()
        .unwrap()
        .contains("drift"));
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
