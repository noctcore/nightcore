//! On-disk PR Review runs (the fourth scan sibling of [`crate::store::insight`]).
//!
//! One pretty-printed JSON file per run at
//! `<project>/.nightcore/pr-reviews/<runId>.json`, mirroring [`crate::store::insight::InsightStore`]'s
//! pattern: an in-memory map behind a `Mutex` is the read source of truth, with
//! write-through to disk on every mutation so a restart reloads the same runs.
//! Project-scoped — activating a project [`retarget`](PrReviewStore::retarget)s the
//! store at that project's `.nightcore/pr-reviews/`.
//!
//! The finding LIFECYCLE (open / dismissed / converted) is owned here, not by the
//! engine: the engine emits stateless [`crate::contracts::ReviewFinding`]s; this store
//! stamps status + `linkedTaskId` and carries dismissed-history across re-runs by
//! fingerprint (like Insight). Grounding is DIFF-relative and lives sidecar-side — a
//! finding's `file` is validated against the PR's changed-file set, NOT checked on disk.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

use crate::store::insight::InsightUsage;
use crate::store::run_store::{LifecycleItem, PersistedRun, RunStore};

// The convert-to-task link outcome is one shared enum across every scan feature (Insight
// defines the canonical one). PR Review's `link_finding_task` returns the same shape, so
// it re-exports rather than defining a twin — the shared
// `sidecar::convert::convert_to_task` helper takes exactly one type.
pub use crate::store::insight::LinkOutcome;

/// A persisted PR-review finding: the engine's review output plus the Rust-owned
/// lifecycle fields (`status`, `linkedTaskId`). `lens`/`severity`/`status` are stored as
/// their wire strings (the web casts them to its unions) so this struct never has to
/// mirror the contract enums. Unlike Insight there is no nested `location` — a review
/// finding carries `file` + optional `line` directly (diff-relative).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "ReviewFinding.ts"))]
pub struct StoredReviewFinding {
    pub id: String,
    pub lens: String,
    pub severity: String,
    /// Repo-relative path; a member of the PR's changed-file set (diff-relative).
    pub file: String,
    /// 1-based line in the PR head, when localizable.
    pub line: Option<u64>,
    pub title: String,
    pub body: String,
    pub suggested_fix: Option<String>,
    pub fingerprint: String,
    /// Lifecycle: `open` | `dismissed` | `converted`.
    pub status: String,
    /// The board task this finding was converted into, if any.
    pub linked_task_id: Option<String>,
}

impl StoredReviewFinding {
    /// Build a stored finding from one wire `ReviewFinding` JSON object (an element of a
    /// `pr-review-*` event's `findings` array), stamping it `open` and unlinked. Reads
    /// the camelCase wire keys directly so it never depends on the generated serde enums.
    /// Returns `None` if the object is missing required fields.
    pub fn from_wire(v: &Value) -> Option<Self> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        let id = s("id")?;
        let lens = s("lens")?;
        let severity = s("severity")?;
        let file = s("file")?;
        let title = s("title")?;
        let body = s("body")?;
        let fingerprint = s("fingerprint")?;
        Some(Self {
            id,
            lens,
            severity,
            file,
            line: v.get("line").and_then(Value::as_u64),
            title,
            body,
            suggested_fix: s("suggestedFix"),
            fingerprint,
            status: "open".to_string(),
            linked_task_id: None,
        })
    }
}

impl LifecycleItem for StoredReviewFinding {
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

/// One PR Review run, persisted under `.nightcore/pr-reviews/<id>.json`. Reuses the
/// Insight [`InsightUsage`] token totals so the scan features share one usage shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrReviewRun.ts"))]
pub struct PrReviewRun {
    pub id: String,
    pub project_path: String,
    /// The reviewed pull-request number.
    pub pr_number: u64,
    /// `running` | `completed` | `failed`.
    pub status: String,
    /// The lenses requested for this run (wire strings).
    pub lenses: Vec<String>,
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
    pub findings: Vec<StoredReviewFinding>,
    pub error: Option<String>,
}

/// The PR Review run store: a [`RunStore`] over [`PrReviewRun`]. The generic run-level
/// CRUD lives on `RunStore`; only the finding-lifecycle mutators below are PR-Review-specific.
pub type PrReviewStore = RunStore<PrReviewRun>;

impl PersistedRun for PrReviewRun {
    const RUN_LABEL: &'static str = "pr review run";
    const DIR_LABEL: &'static str = "pr-reviews";
    const INTERRUPTED_ERROR: &'static str = "interrupted (app restarted mid-review)";

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

impl PrReviewStore {
    /// One finding within a run (cloned), if present.
    pub fn get_finding(&self, run_id: &str, finding_id: &str) -> Option<StoredReviewFinding> {
        self.read(|runs| {
            runs.get(run_id)
                .and_then(|r| r.findings.iter().find(|f| f.id == finding_id).cloned())
        })
    }

    /// Set a finding's status (and optionally its linked task), persisting the run.
    /// Returns the updated run. Errors if the run OR the finding is unknown — a missing
    /// finding must NOT report phantom success (a silent no-op here would let the convert
    /// path believe a finding was linked when it wasn't, minting a duplicate task on the
    /// next click).
    pub fn set_finding_status(
        &self,
        run_id: &str,
        finding_id: &str,
        status: &str,
        linked_task_id: Option<Option<String>>,
    ) -> Result<PrReviewRun, String> {
        self.set_item_status(
            run_id,
            finding_id,
            "finding",
            status,
            linked_task_id,
            |run| &mut run.findings,
        )
    }

    /// Atomically link a finding to a task: under ONE lock, if the finding is already
    /// linked return [`LinkOutcome::AlreadyLinked`] (the caller discards its freshly-
    /// minted task and returns the existing one); otherwise stamp it `converted` + linked
    /// and return [`LinkOutcome::Linked`]. This closes the convert-to-task TOCTOU: a
    /// check-then-set split across two lock acquisitions would let two concurrent converts
    /// both see `linked_task_id == None` and mint two tasks.
    pub fn link_finding_task(
        &self,
        run_id: &str,
        finding_id: &str,
        task_id: &str,
    ) -> Result<LinkOutcome, String> {
        self.link_item_task(run_id, finding_id, "finding", task_id, |run| {
            &mut run.findings
        })
    }

    /// Merge one lens pass's findings into a still-`running` run so a cancel or crash
    /// keeps the partial results already paid for — and so mid-run dismiss/convert on a
    /// peeked lens has persisted findings to act on. A no-op once the run leaves
    /// `running`: the terminal `pr-review-completed` event is authoritative and owns the
    /// final, cross-lens-deduped set. A newly-arrived finding inherits any in-run
    /// lifecycle already applied to a finding sharing its fingerprint, else the cross-run
    /// `dismissed` set; a finding whose id is already present is skipped (idempotent
    /// re-delivery). Cost/usage accumulate so a cancelled run still shows what it spent.
    pub fn accumulate_findings(
        &self,
        run_id: &str,
        findings: Vec<StoredReviewFinding>,
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
    /// instead of re-surfacing `open` and being re-minted by convert-all on every re-run.
    pub fn converted_fingerprints(&self, except_run: Option<&str>) -> HashMap<String, String> {
        self.converted_item_fingerprints(except_run, |run| run.findings.as_slice())
    }

    /// Every fingerprint a user has DISMISSED across all runs (optionally excluding
    /// `except_run`). Used to carry dismissed-history forward: a re-discovered finding
    /// whose fingerprint was previously dismissed stays dismissed.
    pub fn dismissed_fingerprints(&self, except_run: Option<&str>) -> HashSet<String> {
        self.dismissed_item_fingerprints(except_run, |run| run.findings.as_slice())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::run_store::MAX_RUNS;
    use tempfile::TempDir;

    fn store() -> (PrReviewStore, TempDir) {
        let tmp = TempDir::new().expect("temp dir");
        let store = PrReviewStore::load_from(tmp.path().join("pr-reviews"));
        (store, tmp)
    }

    fn finding(id: &str, fp: &str) -> StoredReviewFinding {
        StoredReviewFinding {
            id: id.to_string(),
            lens: "security".into(),
            severity: "high".into(),
            file: "src/a.ts".into(),
            line: Some(10),
            title: "t".into(),
            body: "b".into(),
            suggested_fix: None,
            fingerprint: fp.to_string(),
            status: "open".into(),
            linked_task_id: None,
        }
    }

    fn run(id: &str, findings: Vec<StoredReviewFinding>) -> PrReviewRun {
        PrReviewRun {
            id: id.to_string(),
            project_path: "/proj".into(),
            pr_number: 42,
            status: "completed".into(),
            lenses: vec!["security".into()],
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
        assert_eq!(store.get("r1").unwrap().pr_number, 42);
        assert_eq!(store.list().len(), 1);
        // Reload from disk reconstructs the run.
        let reloaded = PrReviewStore::load_from(tmp.path().join("pr-reviews"));
        assert_eq!(reloaded.get("r1").unwrap().findings[0].fingerprint, "fp1");
    }

    #[test]
    fn from_wire_parses_a_finding_object() {
        let v = serde_json::json!({
            "id": "security-abc",
            "lens": "security",
            "severity": "high",
            "file": "src/new.rs",
            "line": 12,
            "title": "Unsanitized input",
            "body": "reaches the query",
            "suggestedFix": "parameterize it",
            "fingerprint": "fp"
        });
        let f = StoredReviewFinding::from_wire(&v).expect("parse");
        assert_eq!(f.lens, "security");
        assert_eq!(f.file, "src/new.rs");
        assert_eq!(f.line, Some(12));
        assert_eq!(f.suggested_fix.as_deref(), Some("parameterize it"));
        assert_eq!(f.status, "open");
        assert!(f.linked_task_id.is_none());
    }

    #[test]
    fn from_wire_returns_none_on_missing_required_field() {
        // Missing `body` (a required field) ⇒ None, never a half-built finding.
        let v = serde_json::json!({
            "id": "x", "lens": "logic", "severity": "low",
            "file": "a.ts", "title": "t", "fingerprint": "fp"
        });
        assert!(StoredReviewFinding::from_wire(&v).is_none());
    }

    #[test]
    fn from_wire_tolerates_absent_line_and_fix() {
        let v = serde_json::json!({
            "id": "x", "lens": "logic", "severity": "low",
            "file": "a.ts", "title": "t", "body": "b", "fingerprint": "fp"
        });
        let f = StoredReviewFinding::from_wire(&v).expect("parse");
        assert!(f.line.is_none());
        assert!(f.suggested_fix.is_none());
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
