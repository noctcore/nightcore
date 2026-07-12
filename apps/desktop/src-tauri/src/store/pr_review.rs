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
    /// Review lenses OTHER than `lens` that independently surfaced this same issue —
    /// carried through from the wire finding's `corroboratedBy` (the cross-lens dedup
    /// populates it) so the corroborating signal survives persistence. Wire strings
    /// (the web casts them), like `lens`/`severity`. Additive + optional: absent when
    /// only the reporting lens found it, or from an older engine that never emits it.
    pub corroborated_by: Option<Vec<String>>,
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
            // `corroboratedBy` arrives as an array of lens wire strings; keep the string
            // members and drop any non-string element rather than failing the whole finding.
            corroborated_by: v
                .get("corroboratedBy")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                }),
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
    /// Deep mode (issue #294): per-lens round count (1-based), keyed by the review lens
    /// wire string. Persisted so "round N" survives reconcile/resume; empty for a classic
    /// single-pass review (which never emits round events). Because the review is
    /// diff-bounded, a deep run self-limits — the counts stay small.
    #[serde(default)]
    pub rounds_by_lens: std::collections::HashMap<String, u32>,
    pub error: Option<String>,
    /// The synthesis pass's overall merge recommendation (wire `MergeVerdict` string:
    /// `ready` | `merge_with_changes` | `needs_revision` | `blocked`). Stamped from the
    /// `pr-review-completed` event alongside the findings. Additive + optional (fail-open):
    /// absent when the synthesis pass errored/was skipped, or from an older engine.
    pub verdict: Option<String>,
    /// The synthesis pass's short justification for `verdict`; present only when it is.
    pub verdict_reasoning: Option<String>,
    /// True when the mechanical severity→verdict CLAMP overrode the model's proposed
    /// verdict — `verdict` above is then the clamped value. Additive + optional
    /// (fail-open): absent when the model's proposal was already in-band, no verdict was
    /// produced, or from an older engine.
    pub verdict_clamped: Option<bool>,
    /// Why the verdict was clamped — recorded only alongside `verdict_clamped` = true
    /// (e.g. a high-severity finding floored the verdict at `needs_revision`).
    pub clamp_reason: Option<String>,
    /// The PR head commit SHA this run reviewed, captured at start (`gh pr view
    /// --json headRefOid`). Lets the UI flag the review STALE once the PR advances past
    /// it. Best-effort: `None` when the head-oid fetch failed or from an older run.
    pub head_sha: Option<String>,
    /// The review verdict last posted to GitHub from this run (the `approve` /
    /// `request-changes` / `comment` string), stamped best-effort by
    /// `post_review_to_github`. `None` until a post succeeds.
    pub posted_verdict: Option<String>,
    /// Epoch-ms of the last successful GitHub post for this run; paired with
    /// `posted_verdict`. `None` until a post succeeds.
    pub posted_at: Option<u64>,
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
    fn is_finalized(&self) -> bool {
        self.status == "completed" && !self.findings.is_empty()
    }
    fn set_telemetry(
        &mut self,
        cost_usd: f64,
        duration_ms: u64,
        input_tokens: u64,
        output_tokens: u64,
    ) {
        self.cost_usd = cost_usd;
        self.duration_ms = duration_ms;
        self.usage = InsightUsage {
            input_tokens,
            output_tokens,
        };
    }
    fn accumulate_usage(&mut self, cost_usd: f64, input_tokens: u64, output_tokens: u64) {
        self.cost_usd += cost_usd;
        self.usage.input_tokens += input_tokens;
        self.usage.output_tokens += output_tokens;
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
        self.accumulate_items(
            run_id,
            findings,
            dismissed,
            cost_usd,
            input_tokens,
            output_tokens,
            |run| &mut run.findings,
        )
    }

    /// Record a deep-mode round count for a lens (1-based). Running-only, mirroring
    /// [`accumulate_findings`] and the Insight store: a late round event after the
    /// terminal `pr-review-completed` must not touch a finalized run (the status check
    /// happens before the mutate so a non-running run is a true no-op).
    pub fn record_lens_round(&self, run_id: &str, lens: &str, round: u32) {
        if self
            .get(run_id)
            .map(|r| r.status != "running")
            .unwrap_or(true)
        {
            return;
        }
        let _ = self.mutate(run_id, |run| {
            run.rounds_by_lens.insert(lens.to_string(), round);
        });
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
            corroborated_by: None,
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
            rounds_by_lens: HashMap::new(),
            error: None,
            verdict: None,
            verdict_reasoning: None,
            verdict_clamped: None,
            clamp_reason: None,
            head_sha: None,
            posted_verdict: None,
            posted_at: None,
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
    fn verdict_staleness_and_posted_fields_round_trip_through_disk() {
        let (store, tmp) = store();
        let mut r = run("r1", vec![finding("f1", "fp1")]);
        r.verdict = Some("merge_with_changes".into());
        r.verdict_reasoning = Some("two minor nits".into());
        r.head_sha = Some("deadbeef".into());
        r.posted_verdict = Some("comment".into());
        r.posted_at = Some(1_700_000_000_000);
        r.findings[0].corroborated_by = Some(vec!["logic".into(), "performance".into()]);
        store.upsert(&r).unwrap();

        let reloaded = PrReviewStore::load_from(tmp.path().join("pr-reviews"));
        let got = reloaded.get("r1").expect("run reloads");
        assert_eq!(got.verdict.as_deref(), Some("merge_with_changes"));
        assert_eq!(got.verdict_reasoning.as_deref(), Some("two minor nits"));
        assert_eq!(got.head_sha.as_deref(), Some("deadbeef"));
        assert_eq!(got.posted_verdict.as_deref(), Some("comment"));
        assert_eq!(got.posted_at, Some(1_700_000_000_000));
        assert_eq!(
            got.findings[0].corroborated_by.as_deref(),
            Some(["logic".to_string(), "performance".to_string()].as_slice())
        );
    }

    #[test]
    fn deserializes_a_pre_verdict_run_file_additively() {
        // A run JSON written BEFORE the verdict/staleness/posted/corroboration fields
        // existed (none of them present) must still load — the new Option fields default
        // to None, and a finding without `corroboratedBy` loads too. Guards the
        // serde-ADDITIVE contract for on-disk `.nightcore/pr-reviews/<id>.json` files.
        let json = serde_json::json!({
            "id": "r1", "projectPath": "/proj", "prNumber": 42, "status": "completed",
            "lenses": ["security"], "model": "m", "createdAt": 1, "updatedAt": 1,
            "costUsd": 0.0, "durationMs": 0,
            "usage": { "inputTokens": 0, "outputTokens": 0 },
            "findings": [{
                "id": "f1", "lens": "security", "severity": "high", "file": "a.ts",
                "title": "t", "body": "b", "fingerprint": "fp", "status": "open"
            }],
            "error": null
        });
        let run: PrReviewRun = serde_json::from_value(json).expect("legacy run loads");
        assert!(run.verdict.is_none());
        assert!(run.verdict_reasoning.is_none());
        assert!(run.head_sha.is_none());
        assert!(run.posted_verdict.is_none());
        assert!(run.posted_at.is_none());
        assert!(run.findings[0].corroborated_by.is_none());
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
        assert!(f.corroborated_by.is_none(), "absent corroboration ⇒ None");
    }

    #[test]
    fn from_wire_parses_corroborating_lenses() {
        let v = serde_json::json!({
            "id": "x", "lens": "security", "severity": "high",
            "file": "a.ts", "title": "t", "body": "b", "fingerprint": "fp",
            "corroboratedBy": ["logic", "performance", 42]
        });
        let f = StoredReviewFinding::from_wire(&v).expect("parse");
        // The dedup's corroborating lenses survive; a non-string element is dropped, not fatal.
        assert_eq!(
            f.corroborated_by.as_deref(),
            Some(["logic".to_string(), "performance".to_string()].as_slice())
        );
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

    /// A `running` run for `pr_number` (the shape `start_pr_review` persists up front).
    fn running_run(id: &str, pr_number: u64) -> PrReviewRun {
        let mut r = run(id, vec![]);
        r.pr_number = pr_number;
        r.status = "running".into();
        r
    }

    #[test]
    fn upsert_if_idle_when_rejects_a_running_run_for_the_same_pr() {
        let (store, _tmp) = store();
        store
            .upsert_if_idle_when(&running_run("r1", 7), |r| r.pr_number == 7, "busy")
            .unwrap();
        // A second start for the SAME PR is the duplicate-spend case — refused.
        let err = store
            .upsert_if_idle_when(&running_run("r2", 7), |r| r.pr_number == 7, "busy #7")
            .unwrap_err();
        assert_eq!(err, "busy #7");
        assert!(
            store.get("r2").is_none(),
            "the losing run is never inserted"
        );
    }

    #[test]
    fn upsert_if_idle_when_allows_a_concurrent_run_for_a_different_pr() {
        let (store, _tmp) = store();
        store
            .upsert_if_idle_when(&running_run("r1", 7), |r| r.pr_number == 7, "busy")
            .unwrap();
        // A DIFFERENT PR does not conflict: both reviews run concurrently.
        store
            .upsert_if_idle_when(&running_run("r2", 8), |r| r.pr_number == 8, "busy")
            .unwrap();
        assert_eq!(store.get("r1").unwrap().status, "running");
        assert_eq!(store.get("r2").unwrap().status, "running");
        // And a completed run for yet another PR never blocks anything.
        assert!(store
            .upsert_if_idle_when(&running_run("r3", 9), |r| r.pr_number == 9, "busy")
            .is_ok());
    }

    #[test]
    fn upsert_if_idle_still_rejects_any_running_run() {
        // The blanket guard the OTHER scan stores rely on is unchanged: any
        // `running` run — whatever its pr_number — blocks a store-wide insert.
        let (store, _tmp) = store();
        store.upsert(&running_run("r1", 7)).unwrap();
        let err = store
            .upsert_if_idle(&running_run("r2", 8), "busy")
            .unwrap_err();
        assert_eq!(err, "busy");
    }

    #[test]
    fn upsert_if_idle_when_is_atomic_under_racing_starts_for_the_same_pr() {
        // Two racing `start_pr_review` calls for the SAME PR: the conflict check and
        // the insert share ONE `runs` lock, so exactly one may win — the invariant
        // the store-wide guard had, preserved under the scoped predicate.
        let (store, _tmp) = store();
        let store = std::sync::Arc::new(store);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = (0..2)
            .map(|i| {
                let store = std::sync::Arc::clone(&store);
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let r = running_run(&format!("race-{i}"), 7);
                    barrier.wait();
                    store
                        .upsert_if_idle_when(&r, |o| o.pr_number == 7, "busy")
                        .is_ok()
                })
            })
            .collect();
        let wins = threads
            .into_iter()
            .map(|t| t.join().expect("thread"))
            .filter(|&won| won)
            .count();
        assert_eq!(wins, 1, "exactly one racing start may pass the guard");
        assert_eq!(
            store.list().len(),
            1,
            "the loser inserted nothing (no phantom run)"
        );
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
    fn record_lens_round_updates_a_running_run_but_noops_once_settled() {
        // Deep mode (issue #294): the reader's round arm records a per-lens round count
        // ONLY while the run is running; a late round event after the terminal
        // `pr-review-completed` must not touch a finalized run (mirrors Insight).
        let (store, _tmp) = store();
        let mut r = run("live", vec![]);
        r.status = "running".into();
        store.upsert(&r).unwrap();

        store.record_lens_round("live", "security", 2);
        assert_eq!(
            store.get("live").unwrap().rounds_by_lens.get("security"),
            Some(&2)
        );
        // The next round overwrites (round N is 1-based, monotonic per lens).
        store.record_lens_round("live", "security", 3);
        assert_eq!(
            store.get("live").unwrap().rounds_by_lens.get("security"),
            Some(&3)
        );

        // A settled (completed) run is a true no-op — the terminal event is authoritative.
        store.upsert(&run("done", vec![])).unwrap(); // the helper builds a `completed` run
        store.record_lens_round("done", "security", 5);
        assert!(store.get("done").unwrap().rounds_by_lens.is_empty());
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
