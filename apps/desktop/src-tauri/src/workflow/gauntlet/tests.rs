//! Unit tests for the readiness gauntlet, kept together so the detection,
//! sequencing, and reporting cases can share the temp-project / planned-step
//! fixtures.

use std::path::Path;
use std::process::Command;

use super::contract::{GauntletResult, GauntletStep};
use super::detect::{detect_steps, PlannedStep};
use super::run::{run, tail_output};
use crate::store::types::StepStatus;

/// A temp dir with a `package.json` whose `scripts` are the given (name,
/// shell) pairs, plus a `bun.lock` so the runner picks `bun`... except tests
/// drive the scripts through `npm`-free shims by using `node`-free commands.
fn temp_node_project(scripts: &[(&str, &str)]) -> tempfile::TempDir {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let scripts_json: serde_json::Map<String, serde_json::Value> = scripts
        .iter()
        .map(|(k, v)| (k.to_string(), serde_json::Value::String(v.to_string())))
        .collect();
    let pkg = serde_json::json!({ "name": "fake", "scripts": scripts_json });
    std::fs::write(
        tmp.path().join("package.json"),
        serde_json::to_string_pretty(&pkg).unwrap(),
    )
    .unwrap();
    tmp
}

#[test]
fn detects_typecheck_lint_test_in_order() {
    let tmp = temp_node_project(&[("test", "x"), ("lint", "x"), ("typecheck", "x")]);
    let steps = detect_steps(tmp.path());
    let names: Vec<&str> = steps.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["typecheck", "lint", "test"],
        "fixed order regardless of declaration order"
    );
}

#[test]
fn falls_back_to_a_tsc_script_for_typecheck() {
    let tmp = temp_node_project(&[("tsc", "x"), ("test", "x")]);
    let steps = detect_steps(tmp.path());
    let names: Vec<&str> = steps.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["typecheck", "test"]);
}

#[test]
fn prefers_bun_when_a_bun_lock_is_present() {
    let tmp = temp_node_project(&[("test", "x")]);
    std::fs::write(tmp.path().join("bun.lock"), "").unwrap();
    let steps = detect_steps(tmp.path());
    assert_eq!(steps[0].program, "bun");
}

#[test]
fn defaults_to_npm_without_a_bun_lock() {
    let tmp = temp_node_project(&[("test", "x")]);
    let steps = detect_steps(tmp.path());
    assert_eq!(steps[0].program, "npm");
}

#[test]
fn a_project_with_no_tooling_passes_trivially() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let result = run(tmp.path());
    assert!(result.passed, "nothing to run ⇒ pass");
    assert!(result.steps.is_empty());
    assert!(result.failed_step.is_none());
}

/// Run the gauntlet against scripts wired to real shell commands so exit codes
/// are honored. Uses `sh -c` directly (not `npm`) by writing a package.json
/// whose pm we force to a tiny shim: instead we build planned steps by hand.
fn run_planned(steps: Vec<PlannedStep>, dir: &Path) -> GauntletResult {
    // Mirror `run()` but over hand-built steps (so tests don't depend on a real
    // npm/bun being installed). This exercises the same sequencing logic.
    let mut out_steps = Vec::new();
    let mut failed: Option<String> = None;
    for step in steps {
        let command = step.command_line();
        if failed.is_some() {
            out_steps.push(GauntletStep {
                name: step.name,
                command,
                status: StepStatus::Skipped,
                exit_code: None,
                output: None,
            });
            continue;
        }
        let output = Command::new(&step.program)
            .args(&step.args)
            .current_dir(dir)
            .output()
            .expect("spawn sh");
        if output.status.success() {
            out_steps.push(GauntletStep {
                name: step.name,
                command,
                status: StepStatus::Passed,
                exit_code: output.status.code(),
                output: None,
            });
        } else {
            failed = Some(step.name.clone());
            out_steps.push(GauntletStep {
                name: step.name,
                command,
                status: StepStatus::Failed,
                exit_code: output.status.code(),
                output: Some(tail_output(&output.stdout, &output.stderr)),
            });
        }
    }
    GauntletResult {
        passed: failed.is_none(),
        steps: out_steps,
        failed_step: failed,
    }
}

fn sh_step(name: &str, script: &str) -> PlannedStep {
    PlannedStep {
        name: name.to_string(),
        program: "sh".to_string(),
        args: vec!["-c".to_string(), script.to_string()],
    }
}

#[test]
fn a_passing_script_set_passes() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let result = run_planned(
        vec![
            sh_step("typecheck", "exit 0"),
            sh_step("lint", "exit 0"),
            sh_step("test", "exit 0"),
        ],
        tmp.path(),
    );
    assert!(result.passed);
    assert!(result.steps.iter().all(|s| s.status == StepStatus::Passed));
}

#[test]
fn a_failing_test_stops_the_run_and_reports_it() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    // typecheck + lint pass, test fails; nothing after test should run (it is
    // last here, but the skip logic is covered by the failing-lint case below).
    let result = run_planned(
        vec![
            sh_step("typecheck", "exit 0"),
            sh_step("lint", "exit 0"),
            sh_step("test", "echo boom 1>&2; exit 1"),
        ],
        tmp.path(),
    );
    assert!(!result.passed);
    assert_eq!(result.failed_step.as_deref(), Some("test"));
    let typecheck = result.steps.iter().find(|s| s.name == "typecheck").unwrap();
    let lint = result.steps.iter().find(|s| s.name == "lint").unwrap();
    assert_eq!(typecheck.status, StepStatus::Passed);
    assert_eq!(lint.status, StepStatus::Passed);
    let test = result.steps.iter().find(|s| s.name == "test").unwrap();
    assert_eq!(test.status, StepStatus::Failed);
    assert!(test.output.as_deref().unwrap().contains("boom"));
}

#[test]
fn a_failure_skips_every_later_step() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let result = run_planned(
        vec![
            sh_step("typecheck", "exit 1"),
            sh_step("lint", "exit 0"),
            sh_step("test", "exit 0"),
        ],
        tmp.path(),
    );
    assert!(!result.passed);
    assert_eq!(result.failed_step.as_deref(), Some("typecheck"));
    let lint = result.steps.iter().find(|s| s.name == "lint").unwrap();
    let test = result.steps.iter().find(|s| s.name == "test").unwrap();
    assert_eq!(
        lint.status,
        StepStatus::Skipped,
        "no step runs after a failure"
    );
    assert_eq!(test.status, StepStatus::Skipped);
}
