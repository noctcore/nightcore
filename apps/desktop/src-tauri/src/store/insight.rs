//! On-disk Insight analysis runs.
//!
//! One pretty-printed JSON file per run at
//! `<project>/.nightcore/insights/<runId>.json`, mirroring [`TaskStore`]'s
//! pattern: an in-memory map behind a `Mutex` is the read source of truth, with
//! write-through to disk on every mutation so a restart reloads the same runs.
//! Project-scoped like tasks — activating a project [`retarget`](InsightStore::retarget)s
//! the store at that project's `.nightcore/insights/`.
//!
//! The Insight findings LIFECYCLE (open / dismissed / converted) is owned here,
//! not by the engine: the engine emits stateless [`crate::contracts::Finding`]s;
//! this store stamps status + `linkedTaskId` and carries dismissed-history across
//! re-runs by fingerprint (the production fix over Aperant's wipe-and-rerun).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

use crate::store::{is_safe_task_id, write_atomic};

/// Keep at most this many runs per project on disk + in memory; `upsert` prunes the
/// oldest beyond it so analysis history (and its resident `Vec<StoredFinding>`s)
/// can't grow unbounded across daily re-runs.
const MAX_RUNS: usize = 50;

/// The result of an atomic convert-to-task link (see [`InsightStore::link_finding_task`]).
pub enum LinkOutcome {
    /// The finding was unlinked and is now `converted` + linked to the new task.
    Linked,
    /// The finding was ALREADY linked to this task id (idempotent re-convert) — the
    /// caller should discard the task it just minted and return the existing one.
    AlreadyLinked(String),
}

/// A grounded file:line anchor for a finding (mirrors the contract `FindingLocation`
/// but owned Rust-side with ts-rs export for the web). Lines are 1-based.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "FindingLocation.ts"))]
pub struct FindingLocation {
    pub file: String,
    pub start_line: Option<u64>,
    pub end_line: Option<u64>,
    pub symbol: Option<String>,
}

/// A persisted finding: the engine's analysis output plus the Rust-owned lifecycle
/// fields (`status`, `linkedTaskId`). `category`/`severity`/`effort`/`status` are
/// stored as their wire strings (the web casts them to its unions) so this struct
/// never has to mirror the contract enums.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "StoredFinding.ts"))]
pub struct StoredFinding {
    pub id: String,
    pub category: String,
    pub severity: String,
    pub effort: String,
    pub title: String,
    pub description: String,
    pub rationale: Option<String>,
    pub location: Option<FindingLocation>,
    pub suggestion: Option<String>,
    pub code_before: Option<String>,
    pub code_after: Option<String>,
    #[serde(default)]
    pub affected_files: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub confidence: Option<f64>,
    pub fingerprint: String,
    /// Lifecycle: `open` | `dismissed` | `converted`.
    pub status: String,
    /// The board task this finding was converted into, if any.
    pub linked_task_id: Option<String>,
}

impl StoredFinding {
    /// Build a stored finding from one wire `Finding` JSON object (an element of an
    /// `analysis-*` event's `findings` array), stamping it `open` and unlinked.
    /// Reads the camelCase wire keys directly so it never depends on the generated
    /// serde enums. Returns `None` if the object is missing required fields.
    pub fn from_wire(v: &Value) -> Option<Self> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        let id = s("id")?;
        let category = s("category")?;
        let severity = s("severity")?;
        let effort = s("effort")?;
        let title = s("title")?;
        let description = s("description")?;
        let fingerprint = s("fingerprint")?;
        let location = v.get("location").and_then(location_from_wire);
        let affected_files = string_array(v.get("affectedFiles"));
        let tags = string_array(v.get("tags"));
        Some(Self {
            id,
            category,
            severity,
            effort,
            title,
            description,
            rationale: s("rationale"),
            location,
            suggestion: s("suggestion"),
            code_before: s("codeBefore"),
            code_after: s("codeAfter"),
            affected_files,
            tags,
            confidence: v.get("confidence").and_then(Value::as_f64),
            fingerprint,
            status: "open".to_string(),
            linked_task_id: None,
        })
    }
}

fn location_from_wire(v: &Value) -> Option<FindingLocation> {
    let file = v.get("file").and_then(Value::as_str)?.to_string();
    Some(FindingLocation {
        file,
        start_line: v.get("startLine").and_then(Value::as_u64),
        end_line: v.get("endLine").and_then(Value::as_u64),
        symbol: v
            .get("symbol")
            .and_then(Value::as_str)
            .map(str::to_string),
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

/// Token totals for a run, summed across category passes.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "InsightUsage.ts"))]
pub struct InsightUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// One Insight analysis run, persisted under `.nightcore/insights/<id>.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "InsightRun.ts"))]
pub struct InsightRun {
    pub id: String,
    pub project_path: String,
    /// `repo` | `diff`.
    pub scope: String,
    /// `running` | `completed` | `failed`.
    pub status: String,
    /// The categories requested for this run (wire strings).
    pub categories: Vec<String>,
    pub model: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub cost_usd: f64,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub usage: InsightUsage,
    #[serde(default)]
    pub findings: Vec<StoredFinding>,
    pub error: Option<String>,
}

/// The in-memory run map plus the directory it persists to (interior-mutable so it
/// can be retargeted on project switch, exactly like [`TaskStore`]).
pub struct InsightStore {
    runs: Mutex<HashMap<String, InsightRun>>,
    dir: Mutex<PathBuf>,
}

fn read_runs_into_map(dir: &PathBuf) -> HashMap<String, InsightRun> {
    if let Err(e) = std::fs::create_dir_all(dir) {
        tracing::warn!(target: "nightcore::store", dir = %dir.display(), error = %e, "failed to create insights dir");
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
                    Ok(raw) => match serde_json::from_str::<InsightRun>(&raw) {
                        Ok(run) => {
                            runs.insert(run.id.clone(), run);
                        }
                        Err(e) => {
                            tracing::warn!(target: "nightcore::store", path = %path.display(), error = %e, "skipping unparsable insight run")
                        }
                    },
                    Err(e) => {
                        tracing::warn!(target: "nightcore::store", path = %path.display(), error = %e, "cannot read insight run file")
                    }
                }
            }
        }
        Err(e) => {
            tracing::warn!(target: "nightcore::store", dir = %dir.display(), error = %e, "cannot list insights dir")
        }
    }
    runs
}

impl InsightStore {
    /// Load every run file under `dir` into memory, creating the dir if missing.
    pub fn load_from(dir: PathBuf) -> Self {
        let runs = read_runs_into_map(&dir);
        Self {
            runs: Mutex::new(runs),
            dir: Mutex::new(dir),
        }
    }

    /// Re-point the store at `dir` (project switch), clearing + reloading. Existing
    /// files on disk are untouched.
    pub fn retarget(&self, dir: PathBuf) {
        let reloaded = read_runs_into_map(&dir);
        *self.runs.lock().expect("insight store poisoned") = reloaded;
        *self.dir.lock().expect("insight store poisoned") = dir;
    }

    fn path_for(&self, id: &str) -> Result<PathBuf, String> {
        if !is_safe_task_id(id) {
            return Err(format!("invalid run id: {id}"));
        }
        Ok(self
            .dir
            .lock()
            .expect("insight store poisoned")
            .join(format!("{id}.json")))
    }

    /// All runs, newest first (by `created_at`).
    pub fn list(&self) -> Vec<InsightRun> {
        let mut runs: Vec<InsightRun> = self
            .runs
            .lock()
            .expect("insight store poisoned")
            .values()
            .cloned()
            .collect();
        runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        runs
    }

    /// A single run by id.
    pub fn get(&self, id: &str) -> Option<InsightRun> {
        self.runs
            .lock()
            .expect("insight store poisoned")
            .get(id)
            .cloned()
    }

    /// Serialize + atomically write one run to its file. The caller holds the `runs`
    /// lock; this only touches the (separate) `dir` lock via `path_for`.
    fn persist(&self, run: &InsightRun) -> Result<(), String> {
        let path = self.path_for(&run.id)?;
        let json = serde_json::to_string_pretty(run).map_err(|e| e.to_string())?;
        write_atomic(&path, json.as_bytes())
            .map_err(|e| format!("failed to persist insight run {}: {e}", run.id))
    }

    /// Insert or replace a run and write its file (disk-first, like [`TaskStore`]),
    /// then prune the oldest runs beyond [`MAX_RUNS`].
    pub fn upsert(&self, run: &InsightRun) -> Result<(), String> {
        let mut guard = self.runs.lock().expect("insight store poisoned");
        self.persist(run)?;
        guard.insert(run.id.clone(), run.clone());
        self.prune_locked(&mut guard);
        Ok(())
    }

    /// Drop the oldest runs (by `created_at`) beyond [`MAX_RUNS`], deleting their
    /// files. Called under the `runs` lock from `upsert`. Best-effort on the file
    /// delete (a failed unlink is logged, not fatal — the in-memory cap still holds).
    fn prune_locked(&self, guard: &mut std::sync::MutexGuard<'_, HashMap<String, InsightRun>>) {
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
                        tracing::warn!(target: "nightcore::store", run_id = %id, error = %e, "failed to prune old insight run file");
                    }
                }
            }
        }
    }

    /// Mark every run still in `running` as `failed("interrupted")` and persist. A
    /// `running` run at BOOT means the analysis died with the previous process (the
    /// engine/sidecar that drove it is gone), so it can never complete — reaping it
    /// stops the UI from spinning forever. Call ONLY on boot, never on a project
    /// switch (a cross-project run may still be live in the engine).
    pub fn reap_running(&self) {
        let mut guard = self.runs.lock().expect("insight store poisoned");
        let stale: Vec<String> = guard
            .values()
            .filter(|r| r.status == "running")
            .map(|r| r.id.clone())
            .collect();
        for id in stale {
            if let Some(run) = guard.get_mut(&id) {
                run.status = "failed".to_string();
                run.error = Some("interrupted (app restarted mid-analysis)".to_string());
                run.updated_at = crate::task::now_ms();
                let snapshot = run.clone();
                let _ = self.persist(&snapshot);
            }
        }
    }

    /// Delete a run from memory and disk. Idempotent on a missing file.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let path = self.path_for(id)?;
        let mut guard = self.runs.lock().expect("insight store poisoned");
        guard.remove(id);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("failed to delete {}: {e}", path.display())),
        }
    }

    /// Apply `f` to a run, bump `updated_at`, persist, and return it — all under one
    /// lock (so a concurrent finalize/dismiss can't interleave a stale read-write).
    pub fn mutate<F>(&self, id: &str, f: F) -> Result<InsightRun, String>
    where
        F: FnOnce(&mut InsightRun),
    {
        let mut guard = self.runs.lock().expect("insight store poisoned");
        let mut run = guard
            .get(id)
            .cloned()
            .ok_or_else(|| format!("no insight run with id {id}"))?;
        f(&mut run);
        run.updated_at = crate::task::now_ms();
        let path = self.path_for(&run.id)?;
        let json = serde_json::to_string_pretty(&run).map_err(|e| e.to_string())?;
        write_atomic(&path, json.as_bytes())
            .map_err(|e| format!("failed to persist insight run {}: {e}", run.id))?;
        guard.insert(run.id.clone(), run.clone());
        Ok(run)
    }

    /// One finding within a run (cloned), if present.
    pub fn get_finding(&self, run_id: &str, finding_id: &str) -> Option<StoredFinding> {
        self.runs
            .lock()
            .expect("insight store poisoned")
            .get(run_id)
            .and_then(|r| r.findings.iter().find(|f| f.id == finding_id).cloned())
    }

    /// Set a finding's status (and optionally its linked task), persisting the run.
    /// Returns the updated run. Errors if the run OR the finding is unknown — a
    /// missing finding must NOT report phantom success (a silent no-op here would
    /// let the convert path believe a finding was linked when it wasn't, minting a
    /// duplicate task on the next click).
    pub fn set_finding_status(
        &self,
        run_id: &str,
        finding_id: &str,
        status: &str,
        linked_task_id: Option<Option<String>>,
    ) -> Result<InsightRun, String> {
        let mut guard = self.runs.lock().expect("insight store poisoned");
        let mut run = guard
            .get(run_id)
            .cloned()
            .ok_or_else(|| format!("no insight run with id {run_id}"))?;
        let found = match run.findings.iter_mut().find(|f| f.id == finding_id) {
            Some(f) => {
                f.status = status.to_string();
                if let Some(link) = linked_task_id {
                    f.linked_task_id = link;
                }
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

    /// Atomically link a finding to a task: under ONE lock, if the finding is already
    /// linked return [`LinkOutcome::AlreadyLinked`] (the caller discards its freshly-
    /// minted task and returns the existing one); otherwise stamp it `converted` +
    /// linked and return [`LinkOutcome::Linked`]. This closes the convert-to-task
    /// TOCTOU: a check-then-set split across two lock acquisitions would let two
    /// concurrent converts (sync Tauri commands run on a thread pool) both see
    /// `linked_task_id == None` and mint two tasks.
    pub fn link_finding_task(
        &self,
        run_id: &str,
        finding_id: &str,
        task_id: &str,
    ) -> Result<LinkOutcome, String> {
        let mut guard = self.runs.lock().expect("insight store poisoned");
        let mut run = guard
            .get(run_id)
            .cloned()
            .ok_or_else(|| format!("no insight run with id {run_id}"))?;
        let finding = run
            .findings
            .iter_mut()
            .find(|f| f.id == finding_id)
            .ok_or_else(|| format!("no finding {finding_id} in run {run_id}"))?;
        if let Some(existing) = &finding.linked_task_id {
            return Ok(LinkOutcome::AlreadyLinked(existing.clone()));
        }
        finding.status = "converted".to_string();
        finding.linked_task_id = Some(task_id.to_string());
        run.updated_at = crate::task::now_ms();
        self.persist(&run)?;
        guard.insert(run.id.clone(), run.clone());
        Ok(LinkOutcome::Linked)
    }

    /// Every fingerprint a user has DISMISSED across all runs (optionally excluding
    /// `except_run`). Used to carry dismissed-history forward: a re-discovered
    /// finding whose fingerprint was previously dismissed stays dismissed.
    pub fn dismissed_fingerprints(&self, except_run: Option<&str>) -> HashSet<String> {
        let guard = self.runs.lock().expect("insight store poisoned");
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store() -> (InsightStore, TempDir) {
        let tmp = TempDir::new().expect("temp dir");
        let store = InsightStore::load_from(tmp.path().join("insights"));
        (store, tmp)
    }

    fn finding(id: &str, fp: &str) -> StoredFinding {
        StoredFinding {
            id: id.to_string(),
            category: "bugs".into(),
            severity: "high".into(),
            effort: "small".into(),
            title: "t".into(),
            description: "d".into(),
            rationale: None,
            location: None,
            suggestion: None,
            code_before: None,
            code_after: None,
            affected_files: vec![],
            tags: vec![],
            confidence: None,
            fingerprint: fp.to_string(),
            status: "open".into(),
            linked_task_id: None,
        }
    }

    fn run(id: &str, findings: Vec<StoredFinding>) -> InsightRun {
        InsightRun {
            id: id.to_string(),
            project_path: "/proj".into(),
            scope: "repo".into(),
            status: "completed".into(),
            categories: vec!["bugs".into()],
            model: "claude-opus-4-8".into(),
            created_at: 1,
            updated_at: 1,
            cost_usd: 0.0,
            duration_ms: 0,
            usage: InsightUsage::default(),
            findings,
            error: None,
        }
    }

    #[test]
    fn upsert_get_list_round_trip() {
        let (store, tmp) = store();
        store.upsert(&run("r1", vec![finding("f1", "fp1")])).unwrap();
        assert_eq!(store.get("r1").unwrap().findings.len(), 1);
        assert_eq!(store.list().len(), 1);
        // Reload from disk reconstructs the run.
        let reloaded = InsightStore::load_from(tmp.path().join("insights"));
        assert_eq!(reloaded.get("r1").unwrap().findings[0].fingerprint, "fp1");
    }

    #[test]
    fn list_is_newest_first() {
        let (store, _tmp) = store();
        let mut a = run("a", vec![]);
        a.created_at = 10;
        let mut b = run("b", vec![]);
        b.created_at = 20;
        store.upsert(&a).unwrap();
        store.upsert(&b).unwrap();
        let list = store.list();
        assert_eq!(list[0].id, "b", "newest run first");
    }

    #[test]
    fn set_finding_status_persists() {
        let (store, _tmp) = store();
        store.upsert(&run("r1", vec![finding("f1", "fp1")])).unwrap();
        store
            .set_finding_status("r1", "f1", "dismissed", None)
            .unwrap();
        assert_eq!(store.get_finding("r1", "f1").unwrap().status, "dismissed");
    }

    #[test]
    fn convert_links_task() {
        let (store, _tmp) = store();
        store.upsert(&run("r1", vec![finding("f1", "fp1")])).unwrap();
        store
            .set_finding_status("r1", "f1", "converted", Some(Some("task-9".into())))
            .unwrap();
        let f = store.get_finding("r1", "f1").unwrap();
        assert_eq!(f.status, "converted");
        assert_eq!(f.linked_task_id.as_deref(), Some("task-9"));
    }

    #[test]
    fn dismissed_fingerprints_collects_across_runs() {
        let (store, _tmp) = store();
        let mut old = run("old", vec![finding("f1", "shared-fp")]);
        old.findings[0].status = "dismissed".into();
        store.upsert(&old).unwrap();
        store
            .upsert(&run("new", vec![finding("f2", "other-fp")]))
            .unwrap();

        let dismissed = store.dismissed_fingerprints(Some("new"));
        assert!(dismissed.contains("shared-fp"));
        assert!(!dismissed.contains("other-fp"));
    }

    #[test]
    fn from_wire_parses_a_finding_object() {
        let v = serde_json::json!({
            "id": "bugs-abc",
            "category": "bugs",
            "severity": "high",
            "effort": "small",
            "title": "Unawaited promise",
            "description": "drops errors",
            "location": { "file": "src/a.ts", "startLine": 10, "endLine": 12 },
            "affectedFiles": ["src/a.ts"],
            "tags": ["async"],
            "fingerprint": "fp"
        });
        let f = StoredFinding::from_wire(&v).expect("parse");
        assert_eq!(f.category, "bugs");
        assert_eq!(f.location.unwrap().start_line, Some(10));
        assert_eq!(f.affected_files, vec!["src/a.ts"]);
        assert_eq!(f.status, "open");
    }

    #[test]
    fn remove_is_idempotent() {
        let (store, _tmp) = store();
        store.upsert(&run("r1", vec![])).unwrap();
        store.remove("r1").unwrap();
        assert!(store.get("r1").is_none());
        store.remove("r1").unwrap();
    }

    #[test]
    fn set_finding_status_errors_on_missing_finding() {
        // A missing finding must NOT report phantom success (else convert mints dups).
        let (store, _tmp) = store();
        store.upsert(&run("r1", vec![finding("f1", "fp1")])).unwrap();
        assert!(store.set_finding_status("r1", "ghost", "dismissed", None).is_err());
        assert!(store.set_finding_status("nope", "f1", "dismissed", None).is_err());
    }

    #[test]
    fn link_finding_task_is_atomic_and_idempotent() {
        let (store, _tmp) = store();
        store.upsert(&run("r1", vec![finding("f1", "fp1")])).unwrap();

        // First link succeeds and stamps converted + linked.
        match store.link_finding_task("r1", "f1", "task-1").unwrap() {
            LinkOutcome::Linked => {}
            LinkOutcome::AlreadyLinked(_) => panic!("first link should be Linked"),
        }
        let f = store.get_finding("r1", "f1").unwrap();
        assert_eq!(f.status, "converted");
        assert_eq!(f.linked_task_id.as_deref(), Some("task-1"));

        // A second link (the losing race) returns the existing task id, no mutation.
        match store.link_finding_task("r1", "f1", "task-2").unwrap() {
            LinkOutcome::AlreadyLinked(existing) => assert_eq!(existing, "task-1"),
            LinkOutcome::Linked => panic!("second link must be AlreadyLinked"),
        }
        assert_eq!(
            store.get_finding("r1", "f1").unwrap().linked_task_id.as_deref(),
            Some("task-1"),
            "the original link is preserved"
        );
    }

    #[test]
    fn reap_running_marks_running_failed() {
        let (store, _tmp) = store();
        let mut r = run("r1", vec![]);
        r.status = "running".into();
        store.upsert(&r).unwrap();
        store.upsert(&run("r2", vec![])).unwrap(); // already completed

        store.reap_running();
        assert_eq!(store.get("r1").unwrap().status, "failed");
        assert!(store.get("r1").unwrap().error.is_some());
        assert_eq!(store.get("r2").unwrap().status, "completed", "untouched");
    }

    #[test]
    fn upsert_prunes_oldest_beyond_the_cap() {
        let (store, _tmp) = store();
        // Insert MAX_RUNS + 5 runs with increasing created_at; the 5 oldest prune out.
        for i in 0..(MAX_RUNS + 5) {
            let mut r = run(&format!("r{i}"), vec![]);
            r.created_at = i as u64;
            store.upsert(&r).unwrap();
        }
        assert_eq!(store.list().len(), MAX_RUNS, "capped at MAX_RUNS");
        assert!(store.get("r0").is_none(), "oldest run pruned");
        assert!(
            store.get(&format!("r{}", MAX_RUNS + 4)).is_some(),
            "newest run kept"
        );
    }
}
