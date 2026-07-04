//! On-disk Readiness Scorecard runs (the Profile twin of [`crate::store::insight`]).
//!
//! One pretty-printed JSON file per run at
//! `<project>/.nightcore/scorecards/<runId>.json`, mirroring [`crate::store::insight::InsightStore`]'s
//! pattern: an in-memory map behind a `Mutex` is the read source of truth, with
//! write-through to disk on every mutation so a restart reloads the same runs.
//! Project-scoped — activating a project [`retarget`](ScorecardStore::retarget)s the
//! store at that project's `.nightcore/scorecards/`.
//!
//! The Scorecard reading LIFECYCLE (open / converted) is owned here, not by the
//! engine: the engine emits stateless [`crate::contracts::ScorecardReading`]s; this
//! store stamps status + `linkedTaskId`. UNLIKE Insight there is NO `dismissed`
//! state and NO cross-run dedup — every scorecard run is a fresh snapshot grade.

use serde::{Deserialize, Serialize};
use serde_json::Value;
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

use crate::store::insight::{FindingLocation, InsightUsage};
use crate::store::run_store::{LifecycleItem, PersistedRun, RunStore};

// The convert-to-task link outcome is one shared enum across every scan feature (Insight
// defines the canonical one; Harness already re-exports it). Scorecard's
// `link_reading_task` returns the same shape, so it re-exports rather than defining a
// twin — the shared `sidecar::convert::convert_to_task` helper takes exactly one type.
pub use crate::store::insight::LinkOutcome;

/// One grounded piece of evidence under a reading (mirrors the contract
/// `ScorecardEvidence`). `location` reuses the Insight [`FindingLocation`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "ScorecardEvidence.ts"))]
pub struct ScorecardEvidence {
    pub detail: String,
    pub location: Option<FindingLocation>,
}

/// A persisted reading: the engine's grading output plus the Rust-owned lifecycle
/// fields (`status`, `linkedTaskId`). `dimension`/`grade`/`status` are stored as
/// their wire strings (the web casts them to its unions) so this struct never has
/// to mirror the contract enums.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "StoredReading.ts"))]
pub struct StoredReading {
    pub id: String,
    pub dimension: String,
    /// `A` | `B` | `C` | `D` | `E` | `F`.
    pub grade: String,
    pub title: String,
    pub summary: String,
    pub rationale: Option<String>,
    pub location: Option<FindingLocation>,
    pub suggestion: Option<String>,
    #[serde(default)]
    pub affected_files: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub findings: Vec<ScorecardEvidence>,
    pub confidence: Option<f64>,
    pub fingerprint: String,
    /// Lifecycle: `open` | `converted`.
    pub status: String,
    /// The board task this reading was hardened into, if any.
    pub linked_task_id: Option<String>,
}

impl StoredReading {
    /// Build a stored reading from one wire `ScorecardReading` JSON object (an element
    /// of a `scorecard-*` event's `readings`/`reading`), stamping it `open` and
    /// unlinked. Reads the camelCase wire keys directly so it never depends on the
    /// generated serde enums. Returns `None` if missing required fields.
    pub fn from_wire(v: &Value) -> Option<Self> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        let id = s("id")?;
        let dimension = s("dimension")?;
        let grade = s("grade")?;
        let title = s("title")?;
        let summary = s("summary")?;
        let fingerprint = s("fingerprint")?;
        let location = v.get("location").and_then(location_from_wire);
        let affected_files = string_array(v.get("affectedFiles"));
        let tags = string_array(v.get("tags"));
        let findings = v
            .get("findings")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(evidence_from_wire).collect())
            .unwrap_or_default();
        Some(Self {
            id,
            dimension,
            grade,
            title,
            summary,
            rationale: s("rationale"),
            location,
            suggestion: s("suggestion"),
            affected_files,
            tags,
            findings,
            confidence: v.get("confidence").and_then(Value::as_f64),
            fingerprint,
            status: "open".to_string(),
            linked_task_id: None,
        })
    }
}

impl LifecycleItem for StoredReading {
    fn id(&self) -> &str {
        &self.id
    }
    fn status(&self) -> &str {
        &self.status
    }
    fn set_status(&mut self, status: &str) {
        self.status = status.to_string();
    }
    fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
    fn linked_task_id(&self) -> Option<&str> {
        self.linked_task_id.as_deref()
    }
    fn set_linked_task_id(&mut self, task_id: Option<String>) {
        self.linked_task_id = task_id;
    }
}

fn evidence_from_wire(v: &Value) -> Option<ScorecardEvidence> {
    let detail = v.get("detail").and_then(Value::as_str)?.to_string();
    Some(ScorecardEvidence {
        detail,
        location: v.get("location").and_then(location_from_wire),
    })
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

/// One Scorecard run, persisted under `.nightcore/scorecards/<id>.json`. Reuses the
/// Insight [`InsightUsage`] token totals so the two features share one usage shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "ScorecardRun.ts"))]
pub struct ScorecardRun {
    pub id: String,
    pub project_path: String,
    /// `running` | `completed` | `failed`.
    pub status: String,
    /// The dimensions requested for this run (wire strings).
    pub dimensions: Vec<String>,
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
    pub readings: Vec<StoredReading>,
    pub error: Option<String>,
}

/// The Readiness Scorecard run store: a [`RunStore`] over [`ScorecardRun`]. The generic
/// run-level CRUD lives on `RunStore`; only the reading-lifecycle mutators below are
/// Scorecard-specific.
pub type ScorecardStore = RunStore<ScorecardRun>;

impl PersistedRun for ScorecardRun {
    const RUN_LABEL: &'static str = "scorecard run";
    const DIR_LABEL: &'static str = "scorecards";
    const INTERRUPTED_ERROR: &'static str = "interrupted (app restarted mid-scorecard)";

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

impl ScorecardStore {
    /// One reading within a run (cloned), if present.
    pub fn get_reading(&self, run_id: &str, reading_id: &str) -> Option<StoredReading> {
        self.read(|runs| {
            runs.get(run_id)
                .and_then(|r| r.readings.iter().find(|f| f.id == reading_id).cloned())
        })
    }

    /// Set a reading's status (and optionally its linked task), persisting the run.
    /// Returns the updated run. Errors if the run OR the reading is unknown — a
    /// missing reading must NOT report phantom success. UNLIKE [`link_reading_task`],
    /// this UNCONDITIONALLY overwrites the link (mirroring
    /// [`crate::store::insight::InsightStore::set_finding_status`]), so it can re-point
    /// a reading whose previously-linked task was deleted out from under it.
    pub fn set_reading_status(
        &self,
        run_id: &str,
        reading_id: &str,
        status: &str,
        linked_task_id: Option<Option<String>>,
    ) -> Result<ScorecardRun, String> {
        self.set_item_status(
            run_id,
            reading_id,
            "reading",
            status,
            linked_task_id,
            |run| &mut run.readings,
        )
    }

    /// Merge one dimension pass's reading into a still-`running` run so a cancel or
    /// crash keeps the grades already paid for. A no-op once the run leaves `running`:
    /// the terminal `scorecard-completed` event is authoritative. A reading whose id is
    /// already present is skipped (idempotent re-delivery); in-run lifecycle (a reading
    /// hardened live during this run) is preserved by fingerprint. Cost/usage accumulate
    /// so a cancelled run still shows what it spent (the terminal event overwrites these
    /// totals when the run completes cleanly).
    pub fn accumulate_reading(
        &self,
        run_id: &str,
        reading: StoredReading,
        cost_usd: f64,
        input_tokens: u64,
        output_tokens: u64,
    ) -> Result<(), String> {
        self.mutate(run_id, |run| {
            if run.status != "running" {
                return;
            }
            run.cost_usd += cost_usd;
            run.usage.input_tokens += input_tokens;
            run.usage.output_tokens += output_tokens;
            if run.readings.iter().any(|r| r.id == reading.id) {
                return;
            }
            let mut reading = reading;
            if let Some((status, link)) = run
                .readings
                .iter()
                .find(|r| r.fingerprint == reading.fingerprint && r.status != "open")
                .map(|r| (r.status.clone(), r.linked_task_id.clone()))
            {
                reading.status = status;
                reading.linked_task_id = link;
            }
            run.readings.push(reading);
        })
        .map(|_| ())
    }

    /// Atomically link a reading to a task: under ONE lock, if the reading is already
    /// linked return [`LinkOutcome::AlreadyLinked`] (the caller discards its freshly-
    /// minted task and returns the existing one); otherwise stamp it `converted` +
    /// linked and return [`LinkOutcome::Linked`]. This closes the harden-to-task
    /// TOCTOU: a check-then-set split across two lock acquisitions would let two
    /// concurrent hardens (sync Tauri commands run on a thread pool) both see
    /// `linked_task_id == None` and mint two tasks.
    pub fn link_reading_task(
        &self,
        run_id: &str,
        reading_id: &str,
        task_id: &str,
    ) -> Result<LinkOutcome, String> {
        self.link_item_task(run_id, reading_id, "reading", task_id, |run| {
            &mut run.readings
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::run_store::MAX_RUNS;
    use tempfile::TempDir;

    fn store() -> (ScorecardStore, TempDir) {
        let tmp = TempDir::new().expect("temp dir");
        let store = ScorecardStore::load_from(tmp.path().join("scorecards"));
        (store, tmp)
    }

    fn reading(id: &str, fp: &str) -> StoredReading {
        StoredReading {
            id: id.to_string(),
            dimension: "security".into(),
            grade: "C".into(),
            title: "t".into(),
            summary: "s".into(),
            rationale: None,
            location: None,
            suggestion: None,
            affected_files: vec![],
            tags: vec![],
            findings: vec![],
            confidence: None,
            fingerprint: fp.to_string(),
            status: "open".into(),
            linked_task_id: None,
        }
    }

    fn run(id: &str, readings: Vec<StoredReading>) -> ScorecardRun {
        ScorecardRun {
            id: id.to_string(),
            project_path: "/proj".into(),
            status: "completed".into(),
            dimensions: vec!["security".into()],
            model: "claude-opus-4-8".into(),
            created_at: 1,
            updated_at: 1,
            cost_usd: 0.0,
            duration_ms: 0,
            usage: InsightUsage::default(),
            readings,
            error: None,
        }
    }

    #[test]
    fn upsert_get_list_round_trip() {
        let (store, tmp) = store();
        store
            .upsert(&run("r1", vec![reading("f1", "fp1")]))
            .unwrap();
        assert_eq!(store.get("r1").unwrap().readings.len(), 1);
        assert_eq!(store.list().len(), 1);
        let reloaded = ScorecardStore::load_from(tmp.path().join("scorecards"));
        assert_eq!(reloaded.get("r1").unwrap().readings[0].fingerprint, "fp1");
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
        assert_eq!(store.list()[0].id, "b", "newest run first");
    }

    #[test]
    fn from_wire_parses_a_reading_object() {
        let v = serde_json::json!({
            "id": "security-abc",
            "dimension": "security",
            "grade": "C",
            "title": "Input validation gaps",
            "summary": "Handlers trust unvalidated bodies",
            "location": { "file": "src/a.ts", "startLine": 10, "endLine": 12 },
            "affectedFiles": ["src/a.ts"],
            "tags": ["cwe-20"],
            "findings": [
                { "detail": "updateUser trusts req.body", "location": { "file": "src/a.ts", "startLine": 14 } }
            ],
            "fingerprint": "fp"
        });
        let r = StoredReading::from_wire(&v).expect("parse");
        assert_eq!(r.dimension, "security");
        assert_eq!(r.grade, "C");
        assert_eq!(r.location.unwrap().start_line, Some(10));
        assert_eq!(r.findings.len(), 1);
        assert_eq!(
            r.findings[0].location.as_ref().unwrap().start_line,
            Some(14)
        );
        assert_eq!(r.status, "open");
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
    fn link_reading_task_is_atomic_and_idempotent() {
        let (store, _tmp) = store();
        store
            .upsert(&run("r1", vec![reading("f1", "fp1")]))
            .unwrap();

        match store.link_reading_task("r1", "f1", "task-1").unwrap() {
            LinkOutcome::Linked => {}
            LinkOutcome::AlreadyLinked(_) => panic!("first link should be Linked"),
        }
        let f = store.get_reading("r1", "f1").unwrap();
        assert_eq!(f.status, "converted");
        assert_eq!(f.linked_task_id.as_deref(), Some("task-1"));

        match store.link_reading_task("r1", "f1", "task-2").unwrap() {
            LinkOutcome::AlreadyLinked(existing) => assert_eq!(existing, "task-1"),
            LinkOutcome::Linked => panic!("second link must be AlreadyLinked"),
        }
        assert_eq!(
            store
                .get_reading("r1", "f1")
                .unwrap()
                .linked_task_id
                .as_deref(),
            Some("task-1"),
            "the original link is preserved"
        );
    }

    #[test]
    fn set_reading_status_persists_and_links() {
        let (store, _tmp) = store();
        store
            .upsert(&run("r1", vec![reading("f1", "fp1")]))
            .unwrap();
        store
            .set_reading_status("r1", "f1", "converted", Some(Some("task-9".into())))
            .unwrap();
        let f = store.get_reading("r1", "f1").unwrap();
        assert_eq!(f.status, "converted");
        assert_eq!(f.linked_task_id.as_deref(), Some("task-9"));
    }

    #[test]
    fn set_reading_status_unconditionally_repoints_an_existing_link() {
        // The dead-task recovery contract: a reading already linked to a (now-deleted)
        // task must be re-pointable, UNLIKE the compare-and-set `link_reading_task`.
        let (store, _tmp) = store();
        store
            .upsert(&run("r1", vec![reading("f1", "fp1")]))
            .unwrap();
        store.link_reading_task("r1", "f1", "dead-task").unwrap();

        store
            .set_reading_status("r1", "f1", "converted", Some(Some("fresh-task".into())))
            .unwrap();
        assert_eq!(
            store
                .get_reading("r1", "f1")
                .unwrap()
                .linked_task_id
                .as_deref(),
            Some("fresh-task"),
            "set_reading_status must overwrite an existing link (heals the dangling link)"
        );
    }

    #[test]
    fn set_reading_status_errors_on_missing_reading() {
        // A missing reading must NOT report phantom success (else convert mints dups).
        let (store, _tmp) = store();
        store
            .upsert(&run("r1", vec![reading("f1", "fp1")]))
            .unwrap();
        assert!(store
            .set_reading_status("r1", "ghost", "converted", None)
            .is_err());
        assert!(store
            .set_reading_status("nope", "f1", "converted", None)
            .is_err());
    }

    #[test]
    fn accumulate_reading_persists_mid_run_and_is_noop_once_completed() {
        let (store, _tmp) = store();
        let mut r = run("r1", vec![]);
        r.status = "running".into();
        store.upsert(&r).unwrap();

        store
            .accumulate_reading("r1", reading("d1", "fp1"), 0.4, 5, 2)
            .unwrap();
        let got = store.get("r1").unwrap();
        assert_eq!(
            got.readings.len(),
            1,
            "the dimension's grade is persisted mid-run"
        );
        assert_eq!(got.cost_usd, 0.4);
        assert_eq!(got.usage.input_tokens, 5);

        // Re-delivery of the same id is idempotent.
        store
            .accumulate_reading("r1", reading("d1", "fp1"), 0.0, 0, 0)
            .unwrap();
        assert_eq!(store.get("r1").unwrap().readings.len(), 1);

        // A completed run is authoritative — no incremental accumulation.
        store.upsert(&run("done", vec![])).unwrap();
        store
            .accumulate_reading("done", reading("d2", "fp2"), 1.0, 0, 0)
            .unwrap();
        assert!(store.get("done").unwrap().readings.is_empty());
    }

    #[test]
    fn reap_running_marks_running_failed() {
        let (store, _tmp) = store();
        let mut r = run("r1", vec![]);
        r.status = "running".into();
        store.upsert(&r).unwrap();
        store.upsert(&run("r2", vec![])).unwrap();

        store.reap_running();
        assert_eq!(store.get("r1").unwrap().status, "failed");
        assert!(store.get("r1").unwrap().error.is_some());
        assert_eq!(store.get("r2").unwrap().status, "completed", "untouched");
    }

    #[test]
    fn upsert_prunes_oldest_beyond_the_cap() {
        let (store, _tmp) = store();
        for i in 0..(MAX_RUNS + 5) {
            let mut r = run(&format!("r{i}"), vec![]);
            r.created_at = i as u64;
            store.upsert(&r).unwrap();
        }
        assert_eq!(store.list().len(), MAX_RUNS, "capped at MAX_RUNS");
        assert!(store.get("r0").is_none(), "oldest run pruned");
        assert!(
            store.get(&format!("r{}", MAX_RUNS + 4)).is_some(),
            "newest kept"
        );
    }
}
