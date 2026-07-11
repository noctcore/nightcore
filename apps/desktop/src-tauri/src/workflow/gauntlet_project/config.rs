//! Parsing + planning of `.nightcore/harness.json`: the [`HarnessCheckKind`]
//! vocabulary, the lenient per-entry config shape, and the load → plan pipeline
//! that turns the manifest into spawnable [`PlannedCheck`]s. Every "skip" path
//! (absent file, malformed JSON, missing `checks` array, disabled/command-less
//! entry) yields nothing so the gate trivially passes.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

/// The default per-check wall-clock timeout when a check declares no `timeoutMs`
/// (or declares a zero/garbage one). Generous enough for a real whole-repo lint /
/// coverage run, but bounded so a genuinely hung check (a watch mode, a stuck
/// install) cannot pin the verification gate forever.
pub(super) const DEFAULT_CHECK_TIMEOUT: Duration = Duration::from_secs(300);

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

/// The wire kinds a Structure-Lock check may be ARMED / edited as — every kind the
/// runner ([`HarnessCheckKind`]) knows how to run. This is the single source of
/// truth for the arm-time allowlist (`sidecar::harness::commands`) AND the Checks
/// Manager's edit validation (`commands::checks`): a kind outside it would land a
/// manifest entry the gauntlet only warn-and-skips (a placebo gate). Kept in
/// lockstep with the enum by [`super::tests`].
pub(crate) const ARMABLE_CHECK_KINDS: &[&str] = &[
    "lint-plugin",
    "dependency-cruiser",
    "coverage-threshold",
    "lockfile-lint",
    "env-contract",
    "secret-scan",
    "mutation-score",
    "ast-grep",
    "api-extractor",
];

/// Whether `kind` is a runnable/armable Structure-Lock check kind (exact,
/// case-sensitive — wire kinds are kebab-case and a near-miss would arm a check
/// that never runs).
pub(crate) fn is_armable_kind(kind: &str) -> bool {
    ARMABLE_CHECK_KINDS.contains(&kind)
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

    /// Security-critical kinds are EXCLUDED from the runner's flaky-retry policy. A
    /// `secret-scan` or `mutation-score` that fails then flips to exit-0 on a retry
    /// must still BLOCK (a leaked secret that momentarily disappears is still a leak;
    /// a mutation score that only clears on a re-run is not a real pass) rather than
    /// be masked as a non-blocking `flaky`. Excluding them also avoids re-running a
    /// side-effecting check (e.g. Stryker) a second time. The greppable single source
    /// of truth for [`super::runner::run_check_with_retry`]'s per-kind decision; kept
    /// in lockstep with the enum by [`super::tests`].
    pub(super) fn is_security_critical(self) -> bool {
        matches!(
            self,
            HarnessCheckKind::SecretScan | HarnessCheckKind::MutationScore
        )
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
    /// Per-check wall-clock timeout in milliseconds (`timeoutMs` on disk). A check
    /// that overruns is killed and recorded as a failure, so a hung check (an
    /// ESLint watch, a stuck install) can never block verification unbounded.
    /// Absent ⇒ [`DEFAULT_CHECK_TIMEOUT`]; a zero/garbage value falls back to the
    /// default too (never "no timeout").
    #[serde(default)]
    timeout_ms: Option<u64>,
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
    /// The resolved per-check wall-clock timeout (config `timeoutMs` or the default).
    pub(super) timeout: std::time::Duration,
}

/// Load + plan the enabled checks from `.nightcore/harness.json` in `dir`. Returns
/// an empty vec for every "skip" path (absent file, malformed JSON, missing
/// `checks` array, all-disabled), so the gate trivially passes in those cases.
pub(super) fn load_checks(dir: &Path) -> Vec<PlannedCheck> {
    // The per-project structure-lock config, resolved through the single
    // manifest seam (`store::harness_manifest` — audit #35).
    let path = crate::store::harness_manifest::manifest_file(dir);
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
    // A declared `timeoutMs` of 0 (or absent) means "use the default" — never
    // "no timeout"; the whole point is that every check is bounded.
    let timeout = cfg
        .timeout_ms
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_CHECK_TIMEOUT);
    Some(PlannedCheck {
        name: cfg.name.clone(),
        kind: cfg.kind,
        command,
        program,
        args,
        timeout,
    })
}
