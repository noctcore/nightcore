//! The persisted Harness wire types and their `from_wire` constructors.
//!
//! Each stored type mirrors one element of the sidecar's stateless `harness-*` event
//! payloads (`ConventionFinding`, `ProposedArtifact`, `RepoProfile`), plus the
//! Rust-owned lifecycle fields. Enum-ish wire fields are stored as their wire strings
//! (the web casts them to its unions) so these structs never mirror the contract enums.

use serde::{Deserialize, Serialize};
use serde_json::Value;
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

// `FindingLocation` is shared with Insight (same grounded file:line anchor) so the
// web gets ONE `FindingLocation.ts` for both features; `FindingLocation::from_wire`
// and `string_array` are the shared wire-parsing helpers, home in `insight`.
use crate::store::insight::{string_array, FindingLocation};

/// A persisted convention finding: the engine's stateless output plus the Rust-owned
/// `status`. Enum-ish fields (`category`/`kind`/`severity`/`status`) are stored as their
/// wire strings (the web casts them to its unions) so this struct never mirrors the
/// contract enums.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "StoredConventionFinding.ts"))]
pub struct StoredConventionFinding {
    pub id: String,
    pub category: String,
    /// `convention` | `gap`.
    pub kind: String,
    pub severity: String,
    pub title: String,
    pub description: String,
    pub rationale: Option<String>,
    #[serde(default)]
    pub evidence: Vec<FindingLocation>,
    pub suggestion: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub confidence: Option<f64>,
    pub fingerprint: String,
    /// Lifecycle: `open` | `dismissed` | `converted`.
    pub status: String,
    /// The board task this finding was converted into, if any. Additive
    /// (`#[serde(default)]`) so pre-convert on-disk scans still deserialize.
    #[serde(default)]
    pub linked_task_id: Option<String>,
}

impl StoredConventionFinding {
    /// Build a stored finding from one wire `ConventionFinding` JSON object (an element
    /// of a `harness-*` event's `findings` array), stamping it `open`.
    pub fn from_wire(v: &Value) -> Option<Self> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Some(Self {
            id: s("id")?,
            category: s("category")?,
            kind: s("kind")?,
            severity: s("severity")?,
            title: s("title")?,
            description: s("description")?,
            rationale: s("rationale"),
            evidence: locations_from_wire(v.get("evidence")),
            suggestion: s("suggestion"),
            tags: string_array(v.get("tags")),
            confidence: v.get("confidence").and_then(Value::as_f64),
            fingerprint: s("fingerprint")?,
            status: "open".to_string(),
            linked_task_id: None,
        })
    }
}

/// A persisted proposed artifact: the engine's stateless proposal plus the Rust-owned
/// `status` + `applied_path`/`applied_at` (set when written to disk).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "StoredProposedArtifact.ts"))]
pub struct StoredProposedArtifact {
    pub id: String,
    /// `lint-meta-rule` | `eslint-rule` | `eslint-plugin-file` | `eslint-config` | `agent-contract`.
    pub kind: String,
    pub group: Option<String>,
    pub group_title: Option<String>,
    pub title: String,
    pub description: String,
    pub rationale: Option<String>,
    pub target_path: String,
    /// `create` | `merge-section`.
    pub write_mode: String,
    pub content: String,
    pub language: Option<String>,
    #[serde(default)]
    pub source_findings: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub confidence: Option<f64>,
    pub fingerprint: String,
    /// Lifecycle: `proposed` | `applied` | `dismissed`.
    pub status: String,
    /// The repo-relative path this artifact was written to, once `applied`.
    pub applied_path: Option<String>,
    /// When it was applied (ms since epoch).
    pub applied_at: Option<u64>,
}

impl StoredProposedArtifact {
    /// Build a stored artifact from one wire `ProposedArtifact` JSON object, stamping it
    /// `proposed` and unapplied.
    pub fn from_wire(v: &Value) -> Option<Self> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Some(Self {
            id: s("id")?,
            kind: s("kind")?,
            group: s("group"),
            group_title: s("groupTitle"),
            title: s("title")?,
            description: s("description")?,
            rationale: s("rationale"),
            target_path: s("targetPath")?,
            write_mode: s("writeMode")?,
            content: v.get("content").and_then(Value::as_str)?.to_string(),
            language: s("language"),
            source_findings: string_array(v.get("sourceFindings")),
            depends_on: string_array(v.get("dependsOn")),
            confidence: v.get("confidence").and_then(Value::as_f64),
            fingerprint: s("fingerprint")?,
            status: "proposed".to_string(),
            applied_path: None,
            applied_at: None,
        })
    }
}

/// A suggested Structure-Lock check carried on a persisted proposal. Data only — arming
/// stays human-gated through `arm_harness_gauntlet_check`. `kind` is a wire string (the
/// contract keeps it un-enumerated so a future gauntlet kind never breaks deserialize).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "StoredHarnessCheck.ts"))]
pub struct StoredHarnessCheck {
    pub name: String,
    pub kind: String,
    pub command: String,
}

impl StoredHarnessCheck {
    fn from_wire(v: &Value) -> Option<Self> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Some(Self {
            name: s("name")?,
            kind: s("kind")?,
            command: s("command")?,
        })
    }
}

/// A persisted task-shaped harness proposal: the engine's stateless proposal plus the
/// Rust-owned `status` + `linked_task_id` (set when converted to a board task). Enum-ish
/// fields (`kind`/`status`) are stored as wire strings (the web casts them to its unions).
/// The convert lifecycle mirrors `StoredConventionFinding` so both share one convert path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "StoredHarnessProposal.ts"))]
pub struct StoredHarnessProposal {
    pub id: String,
    /// `apply-artifacts` | `agent-task`.
    pub kind: String,
    pub title: String,
    pub description: String,
    pub rationale: Option<String>,
    /// `apply-artifacts`: the artifact ids this proposal bundles.
    #[serde(default)]
    pub artifact_ids: Vec<String>,
    /// `agent-task`: the Build-task prompt.
    pub prompt: Option<String>,
    /// `agent-task`: the machine-checkable done-command (→ the converted task's `verify_command`).
    pub verify_command: Option<String>,
    /// The gauntlet check to suggest arming once this proposal's work lands.
    pub harness_check: Option<StoredHarnessCheck>,
    pub confidence: Option<f64>,
    pub fingerprint: String,
    /// Lifecycle: `proposed` | `dismissed` | `converted`.
    pub status: String,
    /// The board task this proposal was converted into, if any. Additive so pre-convert
    /// on-disk scans still deserialize.
    #[serde(default)]
    pub linked_task_id: Option<String>,
}

impl StoredHarnessProposal {
    /// Build a stored proposal from one wire `HarnessProposal` JSON object, stamping it
    /// `proposed` and unlinked.
    pub fn from_wire(v: &Value) -> Option<Self> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Some(Self {
            id: s("id")?,
            kind: s("kind")?,
            title: s("title")?,
            description: s("description")?,
            rationale: s("rationale"),
            artifact_ids: string_array(v.get("artifactIds")),
            prompt: s("prompt"),
            verify_command: s("verifyCommand"),
            harness_check: v
                .get("harnessCheck")
                .and_then(StoredHarnessCheck::from_wire),
            confidence: v.get("confidence").and_then(Value::as_f64),
            fingerprint: s("fingerprint")?,
            status: "proposed".to_string(),
            linked_task_id: None,
        })
    }
}

/// A persisted rule-coverage record (ENFORCE-lite): one convention's enforcement
/// coverage as the engine's stateless coverage join produced it. Unlike the finding /
/// artifact / proposal wire types this carries NO Rust-owned lifecycle — coverage is
/// recomputed every scan, so there is no user-editable state to persist. Enum-ish
/// `status` (`enforced` | `documented-only` | `unenforced`) is stored as its wire
/// string (the web casts it), matching the rest of this module.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "StoredRuleCoverageGap.ts"))]
pub struct StoredRuleCoverageGap {
    pub id: String,
    /// Joins back to the convention finding (its `category | title` sha1).
    pub convention_fingerprint: String,
    pub category: String,
    pub title: String,
    /// `enforced` | `documented-only` | `unenforced`.
    pub status: String,
    /// Enforcing rule ids that cover it (empty unless `enforced`).
    #[serde(default)]
    pub enforced_by: Vec<String>,
    /// Agent-doc claim lines that mention it (populated for `documented-only`).
    #[serde(default)]
    pub documented_in: Vec<String>,
    /// What synthesis could generate to close the gap (an `ArtifactKind` wire string).
    pub suggested_artifact_kind: Option<String>,
    pub fingerprint: String,
}

impl StoredRuleCoverageGap {
    /// Build a stored coverage record from one wire `RuleCoverageGap` JSON object (an
    /// element of `harness-scan-completed`'s `coverage` array).
    pub fn from_wire(v: &Value) -> Option<Self> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Some(Self {
            id: s("id")?,
            convention_fingerprint: s("conventionFingerprint")?,
            category: s("category")?,
            title: s("title")?,
            status: s("status")?,
            enforced_by: string_array(v.get("enforcedBy")),
            documented_in: string_array(v.get("documentedIn")),
            suggested_artifact_kind: s("suggestedArtifactKind"),
            fingerprint: s("fingerprint")?,
        })
    }
}

fn locations_from_wire(v: Option<&Value>) -> Vec<FindingLocation> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(FindingLocation::from_wire).collect())
        .unwrap_or_default()
}

/// Token totals for a scan, summed across passes (+ synthesis).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "HarnessUsage.ts"))]
pub struct HarnessUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// One workspace member of the detected repo profile (wire enums stored as strings).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "StoredRepoPackage.ts"))]
pub struct StoredRepoPackage {
    pub name: String,
    pub path: String,
    /// `app` | `package` | `tool` | `unknown`.
    pub role: String,
}

/// The deterministically-detected repo profile, persisted with the run.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "StoredRepoProfile.ts"))]
pub struct StoredRepoProfile {
    #[serde(default)]
    pub is_monorepo: bool,
    /// `pnpm` | `bun` | `yarn` | `npm` | `turbo` | `nx` | `cargo` | `single` | `unknown`.
    #[serde(default)]
    pub workspace_tool: String,
    #[serde(default)]
    pub packages: Vec<StoredRepoPackage>,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub frameworks: Vec<String>,
    #[serde(default)]
    pub has_eslint_flat_config: bool,
    #[serde(default)]
    pub has_lint_meta: bool,
    #[serde(default)]
    pub has_agent_docs: bool,
    #[serde(default)]
    pub existing_plugins: Vec<String>,
}

impl StoredRepoProfile {
    /// Build from a wire `RepoProfile` JSON object. Tolerant: missing fields fall back
    /// to `Default`, so a partial profile never fails the whole scan persist.
    pub fn from_wire(v: &Value) -> Self {
        let packages = v
            .get("packages")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|p| {
                        Some(StoredRepoPackage {
                            name: p.get("name").and_then(Value::as_str)?.to_string(),
                            path: p.get("path").and_then(Value::as_str)?.to_string(),
                            role: p
                                .get("role")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown")
                                .to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            is_monorepo: v
                .get("isMonorepo")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            workspace_tool: v
                .get("workspaceTool")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
            packages,
            languages: string_array(v.get("languages")),
            frameworks: string_array(v.get("frameworks")),
            has_eslint_flat_config: v
                .get("hasEslintFlatConfig")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            has_lint_meta: v
                .get("hasLintMeta")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            has_agent_docs: v
                .get("hasAgentDocs")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            existing_plugins: string_array(v.get("existingPlugins")),
        }
    }
}

/// One Harness scan, persisted under `.nightcore/harness/<id>.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "HarnessRun.ts"))]
pub struct HarnessRun {
    pub id: String,
    pub project_path: String,
    /// `running` | `completed` | `failed`.
    pub status: String,
    /// The convention lenses requested for this scan (wire strings).
    pub categories: Vec<String>,
    pub model: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub cost_usd: f64,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub usage: HarnessUsage,
    #[serde(default)]
    pub profile: StoredRepoProfile,
    #[serde(default)]
    pub findings: Vec<StoredConventionFinding>,
    /// Deep mode (issue #294): per-lens round count (1-based), keyed by the convention
    /// category wire string. Persisted so "round N" survives reconcile/resume; empty for
    /// a classic single-pass scan (which never emits round events).
    #[serde(default)]
    pub rounds_by_category: std::collections::HashMap<String, u32>,
    #[serde(default)]
    pub artifacts: Vec<StoredProposedArtifact>,
    /// The task-shaped proposals synthesis produced (the unit the user converts to a
    /// board task). Additive (`#[serde(default)]`) so a pre-proposals on-disk scan loads
    /// with an empty set.
    #[serde(default)]
    pub proposals: Vec<StoredHarnessProposal>,
    /// ENFORCE-lite rule coverage: one record per convention (`enforced` /
    /// `documented-only` / `unenforced`). Additive (`#[serde(default)]`) so a
    /// pre-coverage on-disk scan loads with an empty set — no migration, coverage,
    /// not conformance.
    #[serde(default)]
    pub coverage: Vec<StoredRuleCoverageGap>,
    /// Set while the serial synthesis pass runs (after every lens, before the
    /// terminal event) so a run reloaded mid-synthesis still projects the
    /// "Synthesizing…" state instead of the all-lenses-done dead zone.
    #[serde(default)]
    pub synthesizing: bool,
    pub error: Option<String>,
}
