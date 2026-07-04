//! Parsing + planning of `.nightcore/harness.json`: the [`HarnessCheckKind`]
//! vocabulary, the lenient per-entry config shape, and the load → plan pipeline
//! that turns the manifest into spawnable [`PlannedCheck`]s. Every "skip" path
//! (absent file, malformed JSON, missing `checks` array, disabled/command-less
//! entry) yields nothing so the gate trivially passes.

use std::path::Path;

use serde::Deserialize;

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
pub(super) enum HarnessCheckKind {
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
    /// The stable wire string surfaced on a [`crate::store::types::StructureLockCheck`]
    /// (kept as a free string on the result so the UI can render an unknown future
    /// kind gracefully).
    pub(super) fn as_wire(self) -> &'static str {
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
pub(super) struct PlannedCheck {
    pub(super) name: String,
    pub(super) kind: HarnessCheckKind,
    pub(super) command: String,
    pub(super) program: String,
    pub(super) args: Vec<String>,
}

/// Load + plan the enabled checks from `.nightcore/harness.json` in `dir`. Returns
/// an empty vec for every "skip" path (absent file, malformed JSON, missing
/// `checks` array, all-disabled), so the gate trivially passes in those cases.
pub(super) fn load_checks(dir: &Path) -> Vec<PlannedCheck> {
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
