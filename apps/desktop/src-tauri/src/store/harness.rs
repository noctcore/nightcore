//! On-disk Harness scans (codebase convention auditor).
//!
//! One pretty-printed JSON file per run at
//! `<project>/.nightcore/harness/<runId>.json`, mirroring [`crate::store::insight::InsightStore`]:
//! an in-memory map behind a `Mutex` is the read source of truth, with
//! write-through to disk on every mutation. Project-scoped — activating a project
//! [`retarget`](HarnessStore::retarget)s the store at that project's `.nightcore/harness/`.
//!
//! Two lifecycles are owned here, not by the engine:
//! - convention findings: `open` | `dismissed` (carried across re-runs by fingerprint),
//! - proposed artifacts: `proposed` | `applied` | `dismissed`. `applied` records the
//!   repo-relative path the artifact was written to and when. The actual file write
//!   lives in the sidecar command; this store only records the lifecycle transition,
//!   atomically, so a re-scan carries the applied/dismissed state forward by fingerprint
//!   instead of re-proposing harness pieces the user already acted on.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

// `FindingLocation` is shared with Insight (same grounded file:line anchor) so the
// web gets ONE `FindingLocation.ts` for both features.
use crate::store::insight::FindingLocation;
use crate::store::{is_safe_task_id, write_atomic};

/// Keep at most this many scans per project on disk + in memory; `upsert` prunes the
/// oldest beyond it so harness history can't grow unbounded across re-runs.
const MAX_RUNS: usize = 50;

/// The result of an atomic artifact-apply transition (see [`HarnessStore::mark_artifact_applied`]).
pub enum ApplyOutcome {
    /// The artifact was `proposed` and is now `applied` + records its written path.
    Applied,
    /// The artifact was ALREADY `applied` (idempotent re-apply) — the caller should
    /// NOT re-write the file; the existing applied path is returned.
    AlreadyApplied(String),
}

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
    /// Lifecycle: `open` | `dismissed`.
    pub status: String,
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

fn locations_from_wire(v: Option<&Value>) -> Vec<FindingLocation> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(location_from_wire).collect())
        .unwrap_or_default()
}

fn location_from_wire(v: &Value) -> Option<FindingLocation> {
    let file = v.get("file").and_then(Value::as_str)?.to_string();
    Some(FindingLocation {
        file,
        start_line: v.get("startLine").and_then(Value::as_u64),
        end_line: v.get("endLine").and_then(Value::as_u64),
        symbol: v.get("symbol").and_then(Value::as_str).map(str::to_string),
    })
}

fn string_array(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
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
            is_monorepo: v.get("isMonorepo").and_then(Value::as_bool).unwrap_or(false),
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
            has_lint_meta: v.get("hasLintMeta").and_then(Value::as_bool).unwrap_or(false),
            has_agent_docs: v.get("hasAgentDocs").and_then(Value::as_bool).unwrap_or(false),
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
    #[serde(default)]
    pub artifacts: Vec<StoredProposedArtifact>,
    pub error: Option<String>,
}

/// The in-memory scan map plus the directory it persists to (interior-mutable so it
/// can be retargeted on project switch).
pub struct HarnessStore {
    runs: Mutex<HashMap<String, HarnessRun>>,
    dir: Mutex<PathBuf>,
}

fn read_runs_into_map(dir: &PathBuf) -> HashMap<String, HarnessRun> {
    if let Err(e) = std::fs::create_dir_all(dir) {
        tracing::warn!(target: "nightcore::store", dir = %dir.display(), error = %e, "failed to create harness dir");
    }
    let mut runs = HashMap::new();
    match std::fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                match std::fs::read_to_string(&path) {
                    Ok(raw) => match serde_json::from_str::<HarnessRun>(&raw) {
                        Ok(run) => {
                            runs.insert(run.id.clone(), run);
                        }
                        Err(e) => {
                            tracing::warn!(target: "nightcore::store", path = %path.display(), error = %e, "skipping unparsable harness run")
                        }
                    },
                    Err(e) => {
                        tracing::warn!(target: "nightcore::store", path = %path.display(), error = %e, "cannot read harness run file")
                    }
                }
            }
        }
        Err(e) => {
            tracing::warn!(target: "nightcore::store", dir = %dir.display(), error = %e, "cannot list harness dir")
        }
    }
    runs
}

impl HarnessStore {
    /// Load every scan file under `dir` into memory, creating the dir if missing.
    pub fn load_from(dir: PathBuf) -> Self {
        let runs = read_runs_into_map(&dir);
        Self {
            runs: Mutex::new(runs),
            dir: Mutex::new(dir),
        }
    }

    /// Re-point the store at `dir` (project switch), clearing + reloading.
    pub fn retarget(&self, dir: PathBuf) {
        let reloaded = read_runs_into_map(&dir);
        *crate::sync::lock_or_recover(&self.runs) = reloaded;
        *crate::sync::lock_or_recover(&self.dir) = dir;
    }

    fn path_for(&self, id: &str) -> Result<PathBuf, String> {
        if !is_safe_task_id(id) {
            return Err(format!("invalid run id: {id}"));
        }
        Ok(crate::sync::lock_or_recover(&self.dir).join(format!("{id}.json")))
    }

    /// All scans, newest first (by `created_at`).
    pub fn list(&self) -> Vec<HarnessRun> {
        let mut runs: Vec<HarnessRun> = crate::sync::lock_or_recover(&self.runs)
            .values()
            .cloned()
            .collect();
        runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        runs
    }

    /// A single scan by id.
    pub fn get(&self, id: &str) -> Option<HarnessRun> {
        crate::sync::lock_or_recover(&self.runs).get(id).cloned()
    }

    fn persist(&self, run: &HarnessRun) -> Result<(), String> {
        let path = self.path_for(&run.id)?;
        let json = serde_json::to_string_pretty(run).map_err(|e| e.to_string())?;
        write_atomic(&path, json.as_bytes())
            .map_err(|e| format!("failed to persist harness run {}: {e}", run.id))
    }

    /// Insert or replace a scan and write its file, then prune the oldest beyond [`MAX_RUNS`].
    pub fn upsert(&self, run: &HarnessRun) -> Result<(), String> {
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        self.persist(run)?;
        guard.insert(run.id.clone(), run.clone());
        self.prune_locked(&mut guard);
        Ok(())
    }

    fn prune_locked(&self, guard: &mut std::sync::MutexGuard<'_, HashMap<String, HarnessRun>>) {
        if guard.len() <= MAX_RUNS {
            return;
        }
        let mut by_age: Vec<(String, u64)> = guard
            .values()
            .map(|r| (r.id.clone(), r.created_at))
            .collect();
        by_age.sort_by_key(|(_, created)| *created);
        let to_remove = guard.len().saturating_sub(MAX_RUNS);
        for (id, _) in by_age.into_iter().take(to_remove) {
            guard.remove(&id);
            if let Ok(path) = self.path_for(&id) {
                if let Err(e) = std::fs::remove_file(&path) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(target: "nightcore::store", run_id = %id, error = %e, "failed to prune old harness run file");
                    }
                }
            }
        }
    }

    /// Mark every scan still `running` as `failed("interrupted")` — a `running` scan at
    /// BOOT died with the previous process, so it can never complete. Boot-only.
    pub fn reap_running(&self) {
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        let stale: Vec<String> = guard
            .values()
            .filter(|r| r.status == "running")
            .map(|r| r.id.clone())
            .collect();
        for id in stale {
            if let Some(run) = guard.get_mut(&id) {
                run.status = "failed".to_string();
                run.error = Some("interrupted (app restarted mid-scan)".to_string());
                run.updated_at = crate::task::now_ms();
                let snapshot = run.clone();
                let _ = self.persist(&snapshot);
            }
        }
    }

    /// Delete a scan from memory and disk. Idempotent on a missing file.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let path = self.path_for(id)?;
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        guard.remove(id);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("failed to delete {}: {e}", path.display())),
        }
    }

    /// Apply `f` to a scan, bump `updated_at`, persist, and return it — all under one lock.
    pub fn mutate<F>(&self, id: &str, f: F) -> Result<HarnessRun, String>
    where
        F: FnOnce(&mut HarnessRun),
    {
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        let mut run = guard
            .get(id)
            .cloned()
            .ok_or_else(|| format!("no harness run with id {id}"))?;
        f(&mut run);
        run.updated_at = crate::task::now_ms();
        let path = self.path_for(&run.id)?;
        let json = serde_json::to_string_pretty(&run).map_err(|e| e.to_string())?;
        write_atomic(&path, json.as_bytes())
            .map_err(|e| format!("failed to persist harness run {}: {e}", run.id))?;
        guard.insert(run.id.clone(), run.clone());
        Ok(run)
    }

    /// One artifact within a scan (cloned), if present.
    pub fn get_artifact(&self, run_id: &str, artifact_id: &str) -> Option<StoredProposedArtifact> {
        crate::sync::lock_or_recover(&self.runs)
            .get(run_id)
            .and_then(|r| r.artifacts.iter().find(|a| a.id == artifact_id).cloned())
    }

    /// Set a convention finding's status (`open` | `dismissed`), persisting the scan.
    /// Errors if the run OR the finding is unknown — a missing finding must not report
    /// phantom success.
    pub fn set_finding_status(
        &self,
        run_id: &str,
        finding_id: &str,
        status: &str,
    ) -> Result<HarnessRun, String> {
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        let mut run = guard
            .get(run_id)
            .cloned()
            .ok_or_else(|| format!("no harness run with id {run_id}"))?;
        let found = match run.findings.iter_mut().find(|f| f.id == finding_id) {
            Some(f) => {
                f.status = status.to_string();
                true
            }
            None => false,
        };
        if !found {
            return Err(format!("no finding {finding_id} in run {run_id}"));
        }
        run.updated_at = crate::task::now_ms();
        self.persist(&run)?;
        guard.insert(run.id.clone(), run.clone());
        Ok(run)
    }

    /// Set an artifact's status to `proposed` or `dismissed`, persisting the scan. Used by
    /// dismiss/restore; the `applied` transition goes through [`mark_artifact_applied`].
    pub fn set_artifact_status(
        &self,
        run_id: &str,
        artifact_id: &str,
        status: &str,
    ) -> Result<HarnessRun, String> {
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        let mut run = guard
            .get(run_id)
            .cloned()
            .ok_or_else(|| format!("no harness run with id {run_id}"))?;
        let found = match run.artifacts.iter_mut().find(|a| a.id == artifact_id) {
            Some(a) => {
                // Transitioning AWAY from `applied` (dismiss/restore of a written
                // artifact) must clear the applied metadata, else the record keeps a
                // dangling `applied_path`/`applied_at` and `prior_artifact_states` would
                // mis-rank a re-proposed artifact whose file is no longer tracked.
                if a.status == "applied" && status != "applied" {
                    a.applied_path = None;
                    a.applied_at = None;
                }
                a.status = status.to_string();
                true
            }
            None => false,
        };
        if !found {
            return Err(format!("no artifact {artifact_id} in run {run_id}"));
        }
        run.updated_at = crate::task::now_ms();
        self.persist(&run)?;
        guard.insert(run.id.clone(), run.clone());
        Ok(run)
    }

    /// Atomically record that an artifact was written to disk: under ONE lock, if it is
    /// already `applied` return [`ApplyOutcome::AlreadyApplied`] (the caller must NOT
    /// re-write); otherwise stamp it `applied` + record `applied_path`/`applied_at` and
    /// return [`ApplyOutcome::Applied`]. The caller writes the file FIRST (the filesystem
    /// no-clobber on `create` is the real double-write guard) then calls this to commit
    /// the status; the check-and-set here keeps the lifecycle transition itself atomic.
    pub fn mark_artifact_applied(
        &self,
        run_id: &str,
        artifact_id: &str,
        applied_path: &str,
    ) -> Result<(ApplyOutcome, HarnessRun), String> {
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        let mut run = guard
            .get(run_id)
            .cloned()
            .ok_or_else(|| format!("no harness run with id {run_id}"))?;
        let artifact = run
            .artifacts
            .iter_mut()
            .find(|a| a.id == artifact_id)
            .ok_or_else(|| format!("no artifact {artifact_id} in run {run_id}"))?;
        if artifact.status == "applied" {
            let existing = artifact
                .applied_path
                .clone()
                .unwrap_or_else(|| applied_path.to_string());
            return Ok((ApplyOutcome::AlreadyApplied(existing), run));
        }
        artifact.status = "applied".to_string();
        artifact.applied_path = Some(applied_path.to_string());
        artifact.applied_at = Some(crate::task::now_ms());
        run.updated_at = crate::task::now_ms();
        self.persist(&run)?;
        guard.insert(run.id.clone(), run.clone());
        Ok((ApplyOutcome::Applied, run))
    }

    /// Every fingerprint a user has DISMISSED across all scans (optionally excluding
    /// `except_run`). Carries dismissed-history forward for convention findings.
    pub fn dismissed_finding_fingerprints(&self, except_run: Option<&str>) -> HashSet<String> {
        let guard = crate::sync::lock_or_recover(&self.runs);
        let mut set = HashSet::new();
        for run in guard.values() {
            if Some(run.id.as_str()) == except_run {
                continue;
            }
            for f in &run.findings {
                if f.status == "dismissed" {
                    set.insert(f.fingerprint.clone());
                }
            }
        }
        set
    }

    /// Prior artifact lifecycle states by fingerprint across all scans (optionally
    /// excluding `except_run`), so a re-scan carries `applied`/`dismissed` forward
    /// instead of re-proposing a harness piece the user already acted on. A fingerprint
    /// seen in multiple states resolves to the strongest signal: `applied` wins over
    /// `dismissed` wins over `proposed`. Returns `(status, applied_path, applied_at)` so
    /// the carry-forward preserves the original apply timestamp, not just the path.
    pub fn prior_artifact_states(
        &self,
        except_run: Option<&str>,
    ) -> HashMap<String, ArtifactCarry> {
        let guard = crate::sync::lock_or_recover(&self.runs);
        let rank = |s: &str| match s {
            "applied" => 2,
            "dismissed" => 1,
            _ => 0,
        };
        let mut map: HashMap<String, ArtifactCarry> = HashMap::new();
        for run in guard.values() {
            if Some(run.id.as_str()) == except_run {
                continue;
            }
            for a in &run.artifacts {
                if a.status == "proposed" {
                    continue;
                }
                let carry = ArtifactCarry {
                    status: a.status.clone(),
                    applied_path: a.applied_path.clone(),
                    applied_at: a.applied_at,
                };
                match map.entry(a.fingerprint.clone()) {
                    std::collections::hash_map::Entry::Occupied(mut o) => {
                        if rank(&a.status) > rank(&o.get().status) {
                            o.insert(carry);
                        }
                    }
                    std::collections::hash_map::Entry::Vacant(v) => {
                        v.insert(carry);
                    }
                }
            }
        }
        map
    }
}

/// A prior artifact's carried-forward lifecycle for re-scan reconciliation.
pub struct ArtifactCarry {
    pub status: String,
    pub applied_path: Option<String>,
    pub applied_at: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store() -> (HarnessStore, TempDir) {
        let tmp = TempDir::new().expect("temp dir");
        let store = HarnessStore::load_from(tmp.path().join("harness"));
        (store, tmp)
    }

    fn finding(id: &str, fp: &str) -> StoredConventionFinding {
        StoredConventionFinding {
            id: id.to_string(),
            category: "folder-structure".into(),
            kind: "convention".into(),
            severity: "medium".into(),
            title: "t".into(),
            description: "d".into(),
            rationale: None,
            evidence: vec![],
            suggestion: None,
            tags: vec![],
            confidence: None,
            fingerprint: fp.to_string(),
            status: "open".into(),
        }
    }

    fn artifact(id: &str, fp: &str) -> StoredProposedArtifact {
        StoredProposedArtifact {
            id: id.to_string(),
            kind: "agent-contract".into(),
            group: None,
            group_title: None,
            title: "t".into(),
            description: "d".into(),
            rationale: None,
            target_path: "AGENTS.md".into(),
            write_mode: "merge-section".into(),
            content: "## Conventions\n".into(),
            language: Some("markdown".into()),
            source_findings: vec![],
            depends_on: vec![],
            confidence: None,
            fingerprint: fp.to_string(),
            status: "proposed".into(),
            applied_path: None,
            applied_at: None,
        }
    }

    fn run(id: &str) -> HarnessRun {
        HarnessRun {
            id: id.to_string(),
            project_path: "/proj".into(),
            status: "completed".into(),
            categories: vec!["folder-structure".into()],
            model: "claude-opus-4-8".into(),
            created_at: 1,
            updated_at: 1,
            cost_usd: 0.0,
            duration_ms: 0,
            usage: HarnessUsage::default(),
            profile: StoredRepoProfile::default(),
            findings: vec![finding("f1", "fp1")],
            artifacts: vec![artifact("a1", "afp1")],
            error: None,
        }
    }

    #[test]
    fn upsert_get_list_round_trip() {
        let (store, tmp) = store();
        store.upsert(&run("r1")).unwrap();
        assert_eq!(store.get("r1").unwrap().findings.len(), 1);
        assert_eq!(store.get("r1").unwrap().artifacts.len(), 1);
        assert_eq!(store.list().len(), 1);
        let reloaded = HarnessStore::load_from(tmp.path().join("harness"));
        assert_eq!(reloaded.get("r1").unwrap().artifacts[0].fingerprint, "afp1");
    }

    #[test]
    fn dismiss_finding_persists() {
        let (store, _tmp) = store();
        store.upsert(&run("r1")).unwrap();
        store.set_finding_status("r1", "f1", "dismissed").unwrap();
        assert_eq!(
            store.get("r1").unwrap().findings[0].status,
            "dismissed".to_string()
        );
    }

    #[test]
    fn set_finding_status_errors_on_missing() {
        let (store, _tmp) = store();
        store.upsert(&run("r1")).unwrap();
        assert!(store.set_finding_status("r1", "ghost", "dismissed").is_err());
        assert!(store.set_finding_status("nope", "f1", "dismissed").is_err());
    }

    #[test]
    fn mark_artifact_applied_is_atomic_and_idempotent() {
        let (store, _tmp) = store();
        store.upsert(&run("r1")).unwrap();

        match store.mark_artifact_applied("r1", "a1", "AGENTS.md").unwrap().0 {
            ApplyOutcome::Applied => {}
            ApplyOutcome::AlreadyApplied(_) => panic!("first apply should be Applied"),
        }
        let a = store.get_artifact("r1", "a1").unwrap();
        assert_eq!(a.status, "applied");
        assert_eq!(a.applied_path.as_deref(), Some("AGENTS.md"));
        assert!(a.applied_at.is_some());

        // A second apply (the losing race) returns the existing path, no re-write.
        match store.mark_artifact_applied("r1", "a1", "OTHER.md").unwrap().0 {
            ApplyOutcome::AlreadyApplied(existing) => assert_eq!(existing, "AGENTS.md"),
            ApplyOutcome::Applied => panic!("second apply must be AlreadyApplied"),
        }
    }

    #[test]
    fn dismiss_then_restore_artifact() {
        let (store, _tmp) = store();
        store.upsert(&run("r1")).unwrap();
        store.set_artifact_status("r1", "a1", "dismissed").unwrap();
        assert_eq!(store.get_artifact("r1", "a1").unwrap().status, "dismissed");
        store.set_artifact_status("r1", "a1", "proposed").unwrap();
        assert_eq!(store.get_artifact("r1", "a1").unwrap().status, "proposed");
    }

    #[test]
    fn dismissed_finding_fingerprints_collects_across_runs() {
        let (store, _tmp) = store();
        let mut old = run("old");
        old.findings[0].status = "dismissed".into();
        old.findings[0].fingerprint = "shared-fp".into();
        store.upsert(&old).unwrap();
        store.upsert(&run("new")).unwrap();

        let dismissed = store.dismissed_finding_fingerprints(Some("new"));
        assert!(dismissed.contains("shared-fp"));
        assert!(!dismissed.contains("fp1"));
    }

    #[test]
    fn prior_artifact_states_carries_applied_forward() {
        let (store, _tmp) = store();
        let mut old = run("old");
        old.artifacts[0].status = "applied".into();
        old.artifacts[0].applied_path = Some("AGENTS.md".into());
        old.artifacts[0].applied_at = Some(123_456);
        old.artifacts[0].fingerprint = "shared-afp".into();
        store.upsert(&old).unwrap();

        let prior = store.prior_artifact_states(None);
        let carry = prior.get("shared-afp").expect("present");
        assert_eq!(carry.status, "applied");
        assert_eq!(carry.applied_path.as_deref(), Some("AGENTS.md"));
        assert_eq!(carry.applied_at, Some(123_456), "apply timestamp carries forward");
    }

    #[test]
    fn dismissing_an_applied_artifact_clears_applied_metadata() {
        // Transitioning away from `applied` must drop the dangling applied_path/applied_at
        // so a re-proposed artifact isn't mis-ranked as still-on-disk.
        let (store, _tmp) = store();
        let mut r = run("r1");
        r.artifacts[0].status = "applied".into();
        r.artifacts[0].applied_path = Some("AGENTS.md".into());
        r.artifacts[0].applied_at = Some(999);
        store.upsert(&r).unwrap();

        store.set_artifact_status("r1", "a1", "dismissed").unwrap();
        let a = store.get_artifact("r1", "a1").unwrap();
        assert_eq!(a.status, "dismissed");
        assert!(a.applied_path.is_none(), "applied_path cleared");
        assert!(a.applied_at.is_none(), "applied_at cleared");
    }

    #[test]
    fn reap_running_marks_running_failed() {
        let (store, _tmp) = store();
        let mut r = run("r1");
        r.status = "running".into();
        store.upsert(&r).unwrap();
        store.reap_running();
        assert_eq!(store.get("r1").unwrap().status, "failed");
        assert!(store.get("r1").unwrap().error.is_some());
    }

    #[test]
    fn from_wire_parses_finding_and_artifact() {
        let fv = serde_json::json!({
            "id": "folder-structure-abc",
            "category": "folder-structure",
            "kind": "convention",
            "severity": "medium",
            "title": "Folder per component",
            "description": "colocated siblings",
            "evidence": [{ "file": "apps/web/src/x.tsx", "startLine": 1 }],
            "tags": ["folder-per-component"],
            "fingerprint": "fp"
        });
        let f = StoredConventionFinding::from_wire(&fv).expect("parse finding");
        assert_eq!(f.kind, "convention");
        assert_eq!(f.evidence[0].start_line, Some(1));
        assert_eq!(f.status, "open");

        let av = serde_json::json!({
            "id": "pa-1",
            "kind": "agent-contract",
            "title": "Codify in AGENTS.md",
            "description": "managed section",
            "targetPath": "AGENTS.md",
            "writeMode": "merge-section",
            "content": "## Conventions\n",
            "sourceFindings": ["fp"],
            "fingerprint": "afp"
        });
        let a = StoredProposedArtifact::from_wire(&av).expect("parse artifact");
        assert_eq!(a.kind, "agent-contract");
        assert_eq!(a.target_path, "AGENTS.md");
        assert_eq!(a.status, "proposed");
        assert!(a.applied_path.is_none());
    }
}
