//! Tooling detection: probe a worktree root for the real project tooling
//! (npm/bun scripts, or Cargo) and turn it into an ordered list of
//! [`PlannedStep`]s. It NEVER invents commands — it plans only what exists.
//!
//! Detection precedence in the worktree root:
//!   - `package.json` → its `scripts`, picking `typecheck`/`tsc`, then `lint`,
//!     then `test`, run via the project's package manager (prefer `bun` when a
//!     `bun.lock`/`bun.lockb` is present, else `npm`).
//!   - else `Cargo.toml` → `cargo check` → `cargo clippy` (when available) →
//!     `cargo test`.
//!   - neither ⇒ empty (nothing to run).

use std::path::Path;

/// A planned step: a logical name plus the program + args to run for it.
pub(super) struct PlannedStep {
    pub(super) name: String,
    pub(super) program: String,
    pub(super) args: Vec<String>,
}

impl PlannedStep {
    /// The human-readable command line (for the UI and the `command` field).
    pub(super) fn command_line(&self) -> String {
        if self.args.is_empty() {
            self.program.clone()
        } else {
            format!("{} {}", self.program, self.args.join(" "))
        }
    }
}

/// Detect the steps to run in a worktree, in order. Empty ⇒ nothing to run.
pub(super) fn detect_steps(dir: &Path) -> Vec<PlannedStep> {
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
