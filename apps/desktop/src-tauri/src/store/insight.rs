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

use serde::{Deserialize, Serialize};
use serde_json::Value;
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

use crate::store::run_store::{Edit, PersistedRun, RunStore};

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

/// The Insight run store: a [`RunStore`] over [`InsightRun`]. The generic run-level
/// CRUD (load/retarget/list/get/upsert/prune/reap/remove/mutate) lives on `RunStore`;
/// only the finding-lifecycle mutators below are Insight-specific.
pub type InsightStore = RunStore<InsightRun>;

impl PersistedRun for InsightRun {
    const RUN_LABEL: &'static str = "insight run";
    const DIR_LABEL: &'static str = "insights";
    const INTERRUPTED_ERROR: &'static str = "interrupted (app restarted mid-analysis)";

    fn id(&self) -> &str {
        &self.id
    }
    fn created_at(&self) -> u64 {
        self.created_at
    }
    fn status(&self) -> &str {
        &self.status
    }
    fn set_status(&mut self, status: &str) {
        self.status = status.to_string();
    }
    fn set_error(&mut self, error: Option<String>) {
        self.error = error;
    }
    fn set_updated_at(&mut self, updated_at: u64) {
        self.updated_at = updated_at;
    }
}

impl InsightStore {
    /// One finding within a run (cloned), if present.
    pub fn get_finding(&self, run_id: &str, finding_id: &str) -> Option<StoredFinding> {
        self.read(|runs| {
            runs.get(run_id)
                .and_then(|r| r.findings.iter().find(|f| f.id == finding_id).cloned())
        })
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
        let (_, run) = self.edit_run(run_id, |run| {
            let finding = run
                .findings
                .iter_mut()
                .find(|f| f.id == finding_id)
                .ok_or_else(|| format!("no finding {finding_id} in run {run_id}"))?;
            finding.status = status.to_string();
            if let Some(link) = linked_task_id {
                finding.linked_task_id = link;
            }
            Ok(Edit::Commit(()))
        })?;
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
        let (outcome, _) = self.edit_run(run_id, |run| {
            let finding = run
                .findings
                .iter_mut()
                .find(|f| f.id == finding_id)
                .ok_or_else(|| format!("no finding {finding_id} in run {run_id}"))?;
            if let Some(existing) = &finding.linked_task_id {
                return Ok(Edit::Skip(LinkOutcome::AlreadyLinked(existing.clone())));
            }
            finding.status = "converted".to_string();
            finding.linked_task_id = Some(task_id.to_string());
            Ok(Edit::Commit(LinkOutcome::Linked))
        })?;
        Ok(outcome)
    }

    /// Merge one category pass's findings into a still-`running` run so a cancel or
    /// crash keeps the partial results already paid for — and so mid-run dismiss/convert
    /// on a peeked category has persisted findings to act on. A no-op once the run leaves
    /// `running`: the terminal `analysis-completed` event is authoritative and owns the
    /// final, cross-category-deduped set. A newly-arrived finding inherits any in-run
    /// lifecycle already applied to a finding sharing its fingerprint, else the cross-run
    /// `dismissed` set; a finding whose id is already present is skipped (idempotent
    /// re-delivery). Cost/usage accumulate so a cancelled run still shows what it spent
    /// (the terminal event overwrites these totals when the run completes cleanly).
    pub fn accumulate_findings(
        &self,
        run_id: &str,
        findings: Vec<StoredFinding>,
        dismissed: &HashSet<String>,
        cost_usd: f64,
        input_tokens: u64,
        output_tokens: u64,
    ) -> Result<(), String> {
        self.mutate(run_id, |run| {
            if run.status != "running" {
                return;
            }
            let prior: HashMap<String, (String, Option<String>)> = run
                .findings
                .iter()
                .filter(|f| f.status != "open")
                .map(|f| {
                    (
                        f.fingerprint.clone(),
                        (f.status.clone(), f.linked_task_id.clone()),
                    )
                })
                .collect();
            for mut f in findings {
                if run.findings.iter().any(|e| e.id == f.id) {
                    continue;
                }
                if let Some((status, link)) = prior.get(&f.fingerprint) {
                    f.status = status.clone();
                    f.linked_task_id = link.clone();
                } else if dismissed.contains(&f.fingerprint) {
                    f.status = "dismissed".to_string();
                }
                run.findings.push(f);
            }
            run.cost_usd += cost_usd;
            run.usage.input_tokens += input_tokens;
            run.usage.output_tokens += output_tokens;
        })
        .map(|_| ())
    }

    /// Every fingerprint a user has CONVERTED to a task across all runs (optionally
    /// excluding `except_run`), mapped to the task id it was linked to. Used to carry
    /// convert-history forward: a re-discovered finding whose fingerprint was already
    /// converted stays `converted` + linked (when its task still lives, unfinished)
    /// instead of re-surfacing `open` and being re-minted by convert-all on every
    /// re-scan. The caller checks task liveness/status; this only gathers the map.
    pub fn converted_fingerprints(&self, except_run: Option<&str>) -> HashMap<String, String> {
        self.read(|runs| {
            let mut map = HashMap::new();
            for run in runs.values() {
                if Some(run.id.as_str()) == except_run {
                    continue;
                }
                for f in &run.findings {
                    if f.status == "converted" {
                        if let Some(task_id) = &f.linked_task_id {
                            map.insert(f.fingerprint.clone(), task_id.clone());
                        }
                    }
                }
            }
            map
        })
    }

    /// Every fingerprint a user has DISMISSED across all runs (optionally excluding
    /// `except_run`). Used to carry dismissed-history forward: a re-discovered
    /// finding whose fingerprint was previously dismissed stays dismissed.
    pub fn dismissed_fingerprints(&self, except_run: Option<&str>) -> HashSet<String> {
        self.read(|runs| {
            let mut set = HashSet::new();
            for run in runs.values() {
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
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::run_store::MAX_RUNS;
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
        store
            .upsert(&run("r1", vec![finding("f1", "fp1")]))
            .unwrap();
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
        store
            .upsert(&run("r1", vec![finding("f1", "fp1")]))
            .unwrap();
        store
            .set_finding_status("r1", "f1", "dismissed", None)
            .unwrap();
        assert_eq!(store.get_finding("r1", "f1").unwrap().status, "dismissed");
    }

    #[test]
    fn convert_links_task() {
        let (store, _tmp) = store();
        store
            .upsert(&run("r1", vec![finding("f1", "fp1")]))
            .unwrap();
        store
            .set_finding_status("r1", "f1", "converted", Some(Some("task-9".into())))
            .unwrap();
        let f = store.get_finding("r1", "f1").unwrap();
        assert_eq!(f.status, "converted");
        assert_eq!(f.linked_task_id.as_deref(), Some("task-9"));
    }

    #[test]
    fn converted_fingerprints_maps_fingerprint_to_task_across_runs() {
        let (store, _tmp) = store();
        let mut old = run("old", vec![finding("f1", "shared-fp")]);
        old.findings[0].status = "converted".into();
        old.findings[0].linked_task_id = Some("task-7".into());
        store.upsert(&old).unwrap();
        store
            .upsert(&run("new", vec![finding("f2", "other-fp")]))
            .unwrap();

        let converted = store.converted_fingerprints(Some("new"));
        assert_eq!(
            converted.get("shared-fp").map(String::as_str),
            Some("task-7")
        );
        assert!(
            !converted.contains_key("other-fp"),
            "open findings are not carried"
        );
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
        store
            .upsert(&run("r1", vec![finding("f1", "fp1")]))
            .unwrap();
        assert!(store
            .set_finding_status("r1", "ghost", "dismissed", None)
            .is_err());
        assert!(store
            .set_finding_status("nope", "f1", "dismissed", None)
            .is_err());
    }

    #[test]
    fn link_finding_task_is_atomic_and_idempotent() {
        let (store, _tmp) = store();
        store
            .upsert(&run("r1", vec![finding("f1", "fp1")]))
            .unwrap();

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
            store
                .get_finding("r1", "f1")
                .unwrap()
                .linked_task_id
                .as_deref(),
            Some("task-1"),
            "the original link is preserved"
        );
    }

    #[test]
    fn accumulate_findings_persists_into_a_running_run_and_dedups_by_id() {
        let (store, _tmp) = store();
        let mut r = run("r1", vec![]);
        r.status = "running".into();
        store.upsert(&r).unwrap();

        let empty = HashSet::new();
        store
            .accumulate_findings("r1", vec![finding("f1", "fp1")], &empty, 0.5, 10, 3)
            .unwrap();
        let got = store.get("r1").unwrap();
        assert_eq!(
            got.findings.len(),
            1,
            "the pass's finding is persisted mid-run"
        );
        assert_eq!(got.cost_usd, 0.5);
        assert_eq!(got.usage.input_tokens, 10);

        // Re-delivery of the same id is idempotent (no duplicate), cost still accrues.
        store
            .accumulate_findings("r1", vec![finding("f1", "fp1")], &empty, 0.5, 0, 0)
            .unwrap();
        let got = store.get("r1").unwrap();
        assert_eq!(got.findings.len(), 1, "duplicate id is not re-added");
        assert_eq!(got.cost_usd, 1.0, "cost still accumulates across passes");
    }

    #[test]
    fn accumulate_findings_is_a_noop_once_the_run_is_not_running() {
        // The terminal `analysis-completed` event owns the authoritative deduped set; a
        // late category event must never re-inject findings into a finalized run.
        let (store, _tmp) = store();
        store.upsert(&run("done", vec![])).unwrap(); // helper builds a `completed` run
        let empty = HashSet::new();
        store
            .accumulate_findings("done", vec![finding("f1", "fp1")], &empty, 1.0, 0, 0)
            .unwrap();
        let got = store.get("done").unwrap();
        assert!(
            got.findings.is_empty(),
            "no incremental write once not running"
        );
        assert_eq!(got.cost_usd, 0.0);
    }

    #[test]
    fn accumulate_findings_applies_cross_run_dismissed_history() {
        let (store, _tmp) = store();
        let mut r = run("r1", vec![]);
        r.status = "running".into();
        store.upsert(&r).unwrap();
        let mut dismissed = HashSet::new();
        dismissed.insert("fp1".to_string());
        store
            .accumulate_findings("r1", vec![finding("f1", "fp1")], &dismissed, 0.0, 0, 0)
            .unwrap();
        assert_eq!(
            store.get_finding("r1", "f1").unwrap().status,
            "dismissed",
            "a re-surfaced, previously-dismissed finding stays dismissed mid-run"
        );
    }

    #[test]
    fn upsert_if_idle_rejects_a_second_running_run() {
        let (store, _tmp) = store();
        let mut first = run("r1", vec![]);
        first.status = "running".into();
        // No run active yet ⇒ the first start is admitted.
        store.upsert_if_idle(&first, "busy").unwrap();

        // A second start while the first is `running` is rejected (single-flight).
        let mut second = run("r2", vec![]);
        second.status = "running".into();
        assert_eq!(store.upsert_if_idle(&second, "busy").unwrap_err(), "busy");
        assert!(
            store.get("r2").is_none(),
            "the rejected run is not persisted"
        );

        // Once the first is no longer running, a new run is admitted again.
        store
            .mutate("r1", |r| r.status = "completed".into())
            .unwrap();
        store.upsert_if_idle(&second, "busy").unwrap();
        assert!(store.get("r2").is_some());
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
