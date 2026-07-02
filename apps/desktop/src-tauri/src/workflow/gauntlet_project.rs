//! The Structure-Lock Gauntlet (feature #3): a per-project, zero-agent-cost gate
//! that runs the TARGET project's OWN generated harness checks — its custom lint
//! plugin, an architecture-boundary check (dependency-cruiser / import rules), and
//! coverage thresholds — as a deterministic gate BEFORE the paid reviewer, and
//! again at merge. An agent literally cannot merge code that breaks the harness.
//!
//! This is the sibling of [`crate::gauntlet`] (the pre-merge readiness gauntlet),
//! but where that one DETECTS the project's tooling, this one is DRIVEN by an
//! explicit, opt-in config the lint-plugin generator (feature #2) writes alongside
//! the plugin: `.nightcore/harness.json`.
//!
//! Safety posture (false-positive gates are worse than no gate):
//!   - **Absent `.nightcore/harness.json` ⇒ skip ALL checks** (trivially passes),
//!     so existing projects are completely unaffected — every check is opt-in.
//!   - A malformed file (or a missing `checks` array) ⇒ warn-and-skip everything.
//!   - A malformed / un-runnable individual entry ⇒ warn-and-skip just that entry.
//!   - Checks run sequentially, stopping at the first failure (stop-at-first), each
//!     surfacing the exact command it ran so a human can reproduce it.

use std::path::Path;
// Only the test module spawns directly; production checks route through
// `crate::platform::std_command` (Windows-shim aware), like the gauntlet.
#[cfg(test)]
use std::process::Command;

use serde::Deserialize;

// Reuse the gauntlet's tail helper so the two gauntlets truncate identically. The
// persisted result cluster (`StepStatus` / `StructureLockCheck` / `StructureLockResult`)
// lives in the leaf `store::types` module so the stored `Task` model doesn't depend
// on `crate::workflow`; the runner here imports those shapes back down.
use crate::gauntlet::tail_output;
use crate::store::types::{StepStatus, StructureLockCheck, StructureLockResult};

/// The relative path of the per-project structure-lock config, written by the
/// lint-plugin generator (feature #2) alongside the generated plugin.
const CONFIG_REL_PATH: &str = ".nightcore/harness.json";

/// The kind of structure-lock check, mirroring the `.nightcore/harness.json`
/// `kind` vocabulary. Deserialized kebab-case so the on-disk config reads
/// naturally (`"lint-plugin"`, `"dependency-cruiser"`, `"coverage-threshold"`,
/// `"lockfile-lint"`, `"env-contract"`, `"secret-scan"`, `"mutation-score"`,
/// `"ast-grep"`, `"api-extractor"`).
/// Adding a variant here is what makes a manifest entry of that kind RUNNABLE —
/// the arm-time allowlist (which kinds a proposal may write) is gated separately.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum HarnessCheckKind {
    /// The project's own generated ESLint/Biome plugin.
    LintPlugin,
    /// An architecture-boundary check (dependency-cruiser / import rules).
    DependencyCruiser,
    /// A coverage-threshold gate.
    CoverageThreshold,
    /// A lockfile-integrity linter (e.g. `lockfile-lint` over package-lock/bun.lock).
    LockfileLint,
    /// An env-var contract check (declared env schema vs `.env.example` / usage).
    EnvContract,
    /// A secret scanner (e.g. gitleaks/trufflehog over the tree).
    SecretScan,
    /// A mutation-testing score gate (e.g. Stryker threshold).
    MutationScore,
    /// An ast-grep policy-pack scan (`sgconfig.yml` + rule dir, run with `--error`).
    AstGrep,
    /// An api-extractor API-report drift gate (verify mode, i.e. `run` WITHOUT `--local`).
    ApiExtractor,
}

impl HarnessCheckKind {
    /// The stable wire string surfaced on a [`StructureLockCheck`] (kept as a free
    /// string on the result so the UI can render an unknown future kind gracefully).
    fn as_wire(self) -> &'static str {
        match self {
            HarnessCheckKind::LintPlugin => "lint-plugin",
            HarnessCheckKind::DependencyCruiser => "dependency-cruiser",
            HarnessCheckKind::CoverageThreshold => "coverage-threshold",
            HarnessCheckKind::LockfileLint => "lockfile-lint",
            HarnessCheckKind::EnvContract => "env-contract",
            HarnessCheckKind::SecretScan => "secret-scan",
            HarnessCheckKind::MutationScore => "mutation-score",
            HarnessCheckKind::AstGrep => "ast-grep",
            HarnessCheckKind::ApiExtractor => "api-extractor",
        }
    }
}

/// One check as declared in `.nightcore/harness.json`. Parsed leniently (per-entry
/// warn-and-skip) so a single malformed entry never sinks the whole gate.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarnessCheckConfig {
    name: String,
    kind: HarnessCheckKind,
    /// The exact command line to run (e.g. `npx eslint .`). When absent the check
    /// is warn-and-skipped — there is nothing deterministic to run.
    #[serde(default)]
    command: Option<String>,
    /// An optional config path for the tool. Informational metadata in the wire
    /// schema; the `command` itself is expected to already reference it, so it is
    /// parsed-but-not-read by the runner today.
    #[serde(default)]
    #[allow(dead_code)]
    config_path: Option<String>,
    /// Whether this check participates in the gate. Defaults to `true` (a listed
    /// check is on unless explicitly disabled); the file being ABSENT is the
    /// opt-OUT for a whole project.
    #[serde(default = "default_enabled")]
    enabled: bool,
}

/// `enabled` defaults to `true`: a check the generator bothered to list is on
/// unless the user explicitly flips it off.
fn default_enabled() -> bool {
    true
}

/// A planned check: its config metadata plus the resolved program + args to spawn.
struct PlannedCheck {
    name: String,
    kind: HarnessCheckKind,
    command: String,
    program: String,
    args: Vec<String>,
}

/// Load + plan the enabled checks from `.nightcore/harness.json` in `dir`. Returns
/// an empty vec for every "skip" path (absent file, malformed JSON, missing
/// `checks` array, all-disabled), so the gate trivially passes in those cases.
fn load_checks(dir: &Path) -> Vec<PlannedCheck> {
    let path = dir.join(CONFIG_REL_PATH);
    // ABSENT ⇒ skip all (the opt-out for a whole project). A read error other than
    // "not found" is treated the same way (warn-and-skip), never a hard failure.
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(target: "nightcore::structure_lock", error = %e, "malformed .nightcore/harness.json; skipping all checks");
            return Vec::new();
        }
    };
    let Some(entries) = value.get("checks").and_then(|c| c.as_array()) else {
        tracing::warn!(target: "nightcore::structure_lock", "no `checks` array in .nightcore/harness.json; skipping all checks");
        return Vec::new();
    };

    let mut planned = Vec::new();
    for entry in entries {
        match serde_json::from_value::<HarnessCheckConfig>(entry.clone()) {
            Ok(cfg) => {
                if !cfg.enabled {
                    continue;
                }
                match plan_check(&cfg) {
                    Some(p) => planned.push(p),
                    None => {
                        tracing::warn!(target: "nightcore::structure_lock", name = %cfg.name, "structure-lock check has no runnable command; skipping");
                    }
                }
            }
            Err(e) => {
                tracing::warn!(target: "nightcore::structure_lock", error = %e, "malformed structure-lock check entry; skipping it");
            }
        }
    }
    planned
}

/// Resolve a config entry into a spawnable plan. The `command` is split on
/// whitespace into a program + args (the bare program is routed through the
/// platform resolver at spawn time for Windows-shim handling). `None` ⇒ no runnable
/// command (warn-and-skip).
fn plan_check(cfg: &HarnessCheckConfig) -> Option<PlannedCheck> {
    let command = cfg.command.as_ref()?.trim().to_string();
    if command.is_empty() {
        return None;
    }
    let mut tokens = command.split_whitespace();
    let program = tokens.next()?.to_string();
    let args: Vec<String> = tokens.map(|s| s.to_string()).collect();
    Some(PlannedCheck {
        name: cfg.name.clone(),
        kind: cfg.kind,
        command,
        program,
        args,
    })
}

/// Run the structure-lock gauntlet over a directory: load the enabled checks from
/// `.nightcore/harness.json`, run them sequentially, and stop at the first non-zero
/// exit. A project with no config (or no enabled checks) passes trivially.
pub fn run(dir: &Path) -> StructureLockResult {
    let planned = load_checks(dir);
    // No config / no enabled checks: trivially passing (mirrors `gauntlet::empty_pass`).
    if planned.is_empty() {
        return empty_pass();
    }
    let mut checks = Vec::with_capacity(planned.len());
    let mut failed_check: Option<String> = None;

    for check in planned {
        let kind = check.kind.as_wire().to_string();
        if failed_check.is_some() {
            // An earlier check failed: record the rest as skipped (stop-at-first).
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

        tracing::debug!(target: "nightcore::structure_lock", check = %check.name, "running structure-lock check");
        let output = crate::platform::std_command(&check.program)
            .args(&check.args)
            .current_dir(dir)
            .output();

        match output {
            Ok(out) if out.status.success() => {
                tracing::info!(target: "nightcore::structure_lock", check = %check.name, exit_code = ?out.status.code(), "structure-lock check passed");
                checks.push(StructureLockCheck {
                    name: check.name,
                    kind,
                    command: check.command,
                    status: StepStatus::Passed,
                    exit_code: out.status.code(),
                    output: None,
                });
            }
            Ok(out) => {
                // Check NAME + exit code only to the log — never the output body
                // (it ships to the UI payload, never to the tracing sink).
                tracing::error!(target: "nightcore::structure_lock", check = %check.name, exit_code = ?out.status.code(), "structure-lock check failed");
                failed_check = Some(check.name.clone());
                checks.push(StructureLockCheck {
                    name: check.name,
                    kind,
                    command: check.command,
                    status: StepStatus::Failed,
                    exit_code: out.status.code(),
                    output: Some(tail_output(&out.stdout, &out.stderr)),
                });
            }
            Err(e) => {
                // The tool couldn't be launched at all (missing from PATH): a real
                // failure for this check — stop here.
                tracing::error!(target: "nightcore::structure_lock", check = %check.name, error = %e, "structure-lock check could not launch");
                failed_check = Some(check.name.clone());
                checks.push(StructureLockCheck {
                    name: check.name,
                    kind,
                    command: check.command,
                    status: StepStatus::Failed,
                    exit_code: None,
                    output: Some(format!("failed to launch: {e}")),
                });
            }
        }
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
const VERIFY_COMMAND_CHECK: &str = "verify-command";

/// Run a task's per-task verify command ([`crate::task::Task::verify_command`], hardening
/// module #1) as an ADDITIONAL Structure-Lock check, folding its outcome into `result`.
/// Called AFTER the project's `.nightcore/harness.json` checks pass, so the task's own gate
/// runs last (stop-at-first already halted the project checks on any earlier failure). A
/// failing command flips `result.passed`/`failed_check`, routing into the exact same
/// bounded auto-fix / park machinery the project checks use — no new failure path. An
/// empty/blank command is a no-op (nothing deterministic to run). Split on whitespace like
/// [`plan_check`], routed through the platform resolver (Windows-shim aware).
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
    let output = crate::platform::std_command(program)
        .args(&args)
        .current_dir(dir)
        .output();

    let check = match output {
        Ok(out) if out.status.success() => {
            tracing::info!(target: "nightcore::structure_lock", command = %command, exit_code = ?out.status.code(), "task verify command passed");
            StructureLockCheck {
                name: VERIFY_COMMAND_CHECK.to_string(),
                kind: VERIFY_COMMAND_CHECK.to_string(),
                command: command.to_string(),
                status: StepStatus::Passed,
                exit_code: out.status.code(),
                output: None,
            }
        }
        Ok(out) => {
            tracing::error!(target: "nightcore::structure_lock", command = %command, exit_code = ?out.status.code(), "task verify command failed");
            result.passed = false;
            result.failed_check = Some(VERIFY_COMMAND_CHECK.to_string());
            StructureLockCheck {
                name: VERIFY_COMMAND_CHECK.to_string(),
                kind: VERIFY_COMMAND_CHECK.to_string(),
                command: command.to_string(),
                status: StepStatus::Failed,
                exit_code: out.status.code(),
                output: Some(tail_output(&out.stdout, &out.stderr)),
            }
        }
        Err(e) => {
            tracing::error!(target: "nightcore::structure_lock", command = %command, error = %e, "task verify command could not launch");
            result.passed = false;
            result.failed_check = Some(VERIFY_COMMAND_CHECK.to_string());
            StructureLockCheck {
                name: VERIFY_COMMAND_CHECK.to_string(),
                kind: VERIFY_COMMAND_CHECK.to_string(),
                command: command.to_string(),
                status: StepStatus::Failed,
                exit_code: None,
                output: Some(format!("failed to launch: {e}")),
            }
        }
    };
    result.checks.push(check);
}

/// A human-readable fix instruction for the auto-fix loop, naming the failed check,
/// its exact command, and the captured output so the agent can self-correct. Pure,
/// so it's unit-testable without spawning anything.
pub fn fix_instruction(result: &StructureLockResult) -> String {
    match result.checks.iter().find(|c| c.status == StepStatus::Failed) {
        Some(c) => format!(
            "The Structure-Lock Gauntlet failed: the project's own harness check \
             `{name}` did not pass. It MUST pass before this work can be verified or \
             merged. Re-run it locally and fix every violation it reports:\n\n\
             Command: {command}\n\nOutput:\n{output}",
            name = c.name,
            command = c.command,
            output = c.output.as_deref().unwrap_or("(no output captured)"),
        ),
        None => "The Structure-Lock Gauntlet failed. Fix the project's harness \
                 checks before this work can be verified or merged."
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            vec!["lockfile-lint", "env-contract", "secret-scan", "mutation-score"],
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
                sh_check("lint", HarnessCheckKind::LintPlugin, "echo boom 1>&2; exit 1"),
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
                sh_check("surface", HarnessCheckKind::ApiExtractor, "echo drift 1>&2; exit 1"),
            ],
            tmp.path(),
        );
        assert!(!result.passed);
        assert_eq!(result.failed_check.as_deref(), Some("surface"));
        assert_eq!(result.checks[0].status, StepStatus::Passed);
        assert_eq!(result.checks[0].kind, "ast-grep");
        assert_eq!(result.checks[1].status, StepStatus::Failed);
        assert_eq!(result.checks[1].kind, "api-extractor");
        assert!(result.checks[1].output.as_deref().unwrap().contains("drift"));
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

    #[cfg(unix)]
    #[test]
    fn task_verify_command_appends_a_passing_check() {
        // A whitespace-split command (like `npx eslint .` in production) — no shell
        // quoting, matching `plan_check`. `sh -c true` runs the `true` builtin → exit 0.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let mut result = empty_pass();
        append_task_verify_command(&mut result, "sh -c true", tmp.path());
        assert!(result.passed, "a passing verify command keeps the gate green");
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
        assert!(check.output.as_deref().unwrap().contains("no-such-path-nc-xyz"), "captures output for the fix loop");
        // The fix instruction the auto-fix loop feeds back names it + its command.
        let fix = fix_instruction(&result);
        assert!(fix.contains(VERIFY_COMMAND_CHECK) && fix.contains("ls /no-such-path-nc-xyz"));
    }

    #[test]
    fn task_verify_command_blank_is_a_noop() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let mut result = empty_pass();
        append_task_verify_command(&mut result, "   ", tmp.path());
        assert!(result.passed && result.checks.is_empty(), "a blank command adds nothing");
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
}
