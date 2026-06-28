//! Pre-merge readiness gauntlet (M4 §C).
//!
//! A deterministic, zero-agent-cost detector + runner over a task's worktree. It
//! NEVER invents commands: it detects the project's real tooling (npm/bun scripts,
//! or Cargo) and runs only what exists, **stopping at the first failure**. The
//! result gates `merge_task` — the one irreversible action — but not `commit_task`
//! (committing in the isolated worktree is reversible).
//!
//! Detection precedence in the worktree root:
//!   - `package.json` → its `scripts`, picking `typecheck`/`tsc`, then `lint`,
//!     then `test`, run via the project's package manager (prefer `bun` when a
//!     `bun.lock`/`bun.lockb` is present, else `npm`).
//!   - else `Cargo.toml` → `cargo check` → `cargo clippy` (when available) →
//!     `cargo test`.
//!   - neither ⇒ the gauntlet trivially passes (nothing to run).

use std::path::Path;
// Only the test module spawns directly now; production steps route through
// `crate::platform::std_command`.
#[cfg(test)]
use std::process::Command;

use serde::Serialize;
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

// `StepStatus` is the persisted step-outcome enum; it now lives in the leaf
// `store::types` module (it travels inside the stored `Task` via `StructureLockCheck`),
// and `GauntletStep` reads it back down from there.
use crate::store::types::StepStatus;

/// How much of a failing step's output to retain for the UI. Bounded so a noisy
/// failure can't bloat the event payload; truncated from the tail (the part that
/// usually names the failure).
const TAIL_LIMIT: usize = 4000;

/// One detected check and how it went.
// `exit_code`/`output` are OMITTED when absent (`skip_serializing_if` + `default`),
// so the generated TS is `exitCode?: number` / `output?: string` — matching the
// prior hand-mirror's optional `exitCode?` and keeping `output` an optional add
// (the board reads `step.exitCode !== undefined`). Omitting the null is behavior-
// preserving: the prior interface never carried a `null` here.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "GauntletStep.ts"))]
pub struct GauntletStep {
    /// The logical name (`typecheck` / `lint` / `test` / `check` / `clippy`).
    pub name: String,
    /// The exact command line that was (or would be) run.
    pub command: String,
    pub status: StepStatus,
    /// The process exit code, when the step actually ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub exit_code: Option<i32>,
    /// Tail of combined stdout+stderr for a failing step (truncated; never logged).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub output: Option<String>,
}

/// The structured gauntlet result surfaced to the UI.
// `failed_step` is OMITTED when absent (`skip_serializing_if` + `default`), so the
// generated TS is `failedStep?: string` — matching the prior hand-mirror exactly
// (the board reads `result.failedStep ?? 'unknown'`). Omitting the null is
// behavior-preserving: the prior interface never carried a `null` here.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "GauntletResult.ts"))]
pub struct GauntletResult {
    /// True when every detected step passed (vacuously true when none exist).
    pub passed: bool,
    pub steps: Vec<GauntletStep>,
    /// The name of the first step that failed, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub failed_step: Option<String>,
}

/// A planned step: a logical name plus the program + args to run for it.
struct PlannedStep {
    name: String,
    program: String,
    args: Vec<String>,
}

impl PlannedStep {
    /// The human-readable command line (for the UI and the `command` field).
    fn command_line(&self) -> String {
        if self.args.is_empty() {
            self.program.clone()
        } else {
            format!("{} {}", self.program, self.args.join(" "))
        }
    }
}

/// Detect the steps to run in a worktree, in order. Empty ⇒ nothing to run.
fn detect_steps(dir: &Path) -> Vec<PlannedStep> {
    if dir.join("package.json").exists() {
        return detect_node_steps(dir);
    }
    if dir.join("Cargo.toml").exists() {
        return detect_cargo_steps(dir);
    }
    Vec::new()
}

/// Node steps: read `package.json` scripts and pick the ones that exist among
/// `typecheck` (or `tsc`), `lint`, `test`, run via the detected package manager.
fn detect_node_steps(dir: &Path) -> Vec<PlannedStep> {
    let scripts = read_package_scripts(dir);
    let pm = if dir.join("bun.lock").exists() || dir.join("bun.lockb").exists() {
        "bun"
    } else {
        "npm"
    };

    let mut steps = Vec::new();
    // `typecheck` is the conventional name; fall back to a `tsc` script.
    let typecheck = if scripts.iter().any(|s| s == "typecheck") {
        Some("typecheck")
    } else if scripts.iter().any(|s| s == "tsc") {
        Some("tsc")
    } else {
        None
    };
    if let Some(script) = typecheck {
        steps.push(node_step("typecheck", pm, script));
    }
    if scripts.iter().any(|s| s == "lint") {
        steps.push(node_step("lint", pm, "lint"));
    }
    if scripts.iter().any(|s| s == "test") {
        steps.push(node_step("test", pm, "test"));
    }
    steps
}

/// A `<pm> run <script>` step under a logical `name`.
fn node_step(name: &str, pm: &str, script: &str) -> PlannedStep {
    PlannedStep {
        name: name.to_string(),
        program: pm.to_string(),
        args: vec!["run".to_string(), script.to_string()],
    }
}

/// The set of script names declared in a worktree's `package.json`. Empty on any
/// read/parse error (treated as "no scripts").
fn read_package_scripts(dir: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(dir.join("package.json")) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    value
        .get("scripts")
        .and_then(|s| s.as_object())
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default()
}

/// Cargo steps: `cargo check` → `cargo clippy` (when the component is installed)
/// → `cargo test`.
fn detect_cargo_steps(dir: &Path) -> Vec<PlannedStep> {
    let mut steps = vec![PlannedStep {
        name: "check".to_string(),
        program: "cargo".to_string(),
        args: vec!["check".to_string()],
    }];
    if clippy_available(dir) {
        steps.push(PlannedStep {
            name: "clippy".to_string(),
            program: "cargo".to_string(),
            args: vec!["clippy".to_string()],
        });
    }
    steps.push(PlannedStep {
        name: "test".to_string(),
        program: "cargo".to_string(),
        args: vec!["test".to_string()],
    });
    steps
}

/// Whether `cargo clippy` is available (the component is installed). Probed with
/// `cargo clippy --version` so we never plan a step that can't run.
fn clippy_available(dir: &Path) -> bool {
    crate::platform::std_command("cargo")
        .args(["clippy", "--version"])
        .current_dir(dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

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

// --- Command ----------------------------------------------------------------

/// Run the readiness gauntlet for a task on demand (the board's "Run checks"
/// action). Resolves the task's worktree under the active project; with no active
/// project or worktree it returns a trivially-passing empty result.
#[tauri::command]
pub fn run_gauntlet(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::store::TaskStore>,
    id: String,
) -> Result<GauntletResult, String> {
    use tauri::Manager;
    store
        .get(&id)
        .ok_or_else(|| format!("no task with id {id}"))?;

    let Some(project) = app.state::<crate::project::ProjectStore>().active() else {
        return Ok(empty_pass());
    };
    let dir = crate::worktree::worktree_path(&std::path::PathBuf::from(&project.path), &id);
    if !dir.exists() {
        return Ok(empty_pass());
    }
    Ok(run(&dir))
}

/// A trivially-passing result (no worktree / no tooling to run).
pub fn empty_pass() -> GauntletResult {
    GauntletResult {
        passed: true,
        steps: Vec::new(),
        failed_step: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
