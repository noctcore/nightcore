//! On-disk Issue Triage validations (the head of the issue → validate → task →
//! PR → review pipeline).
//!
//! One pretty-/compact-printed JSON file per validation at
//! `<project>/.nightcore/issue-validations/<runId>.json`, mirroring the scan
//! siblings ([`crate::store::pr_review::PrReviewRun`]) via the generic
//! [`RunStore`]. Unlike the scan families this is ONE read-only validation
//! session per issue (not a fan-out of findings): the run carries a SINGLE
//! structured verdict ([`StoredIssueValidationResult`]) rather than a `Vec` of
//! findings, so it needs no per-item lifecycle — only the run-level convert link
//! ([`IssueValidationStore::link_validation_task`]) and the viewed/posted stamps.
//!
//! The stored verdict's enum-typed fields (`issueKind` / `verdict` / `confidence`
//! / `estimatedComplexity` / `prAnalysis.recommendation`) are persisted as their
//! WIRE STRINGS — exactly like [`crate::store::pr_review::StoredReviewFinding`]'s
//! `lens`/`severity` — so this struct never has to mirror the generated contract
//! enums (the web casts the strings back to its unions). Every text field here is
//! GitHub-/model-derived and therefore UNTRUSTED; downstream renders it inside the
//! existing untrusted framing.

use serde::{Deserialize, Serialize};
use serde_json::Value;
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

use crate::store::insight::{InsightUsage, LinkOutcome};
use crate::store::run_store::{Edit, PersistedRun, RunStore};

/// The validation's analysis of a linked open PR, persisted (the stored twin of the
/// contract `IssuePrAnalysis`). `recommendation` is kept as its wire string so this
/// struct never mirrors the generated enum. All prose fields are model-derived
/// (untrusted).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "StoredIssuePrAnalysis.ts"))]
pub struct StoredIssuePrAnalysis {
    /// AUTHORITATIVE: whether the issue has an OPEN linked PR the analysis considered.
    pub has_open_pr: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_fixes_issue: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_summary: Option<String>,
    /// Wire `IssuePrRecommendation` string (`wait_for_merge`/`pr_needs_work`/`no_pr`).
    pub recommendation: String,
}

impl StoredIssuePrAnalysis {
    /// Parse one `prAnalysis` object off a completed event's `result`. Returns `None`
    /// only when the required `hasOpenPr`/`recommendation` fields are missing (a
    /// half-built analysis is dropped, never persisted partial).
    fn from_wire(v: &Value) -> Option<Self> {
        Some(Self {
            has_open_pr: v.get("hasOpenPr").and_then(Value::as_bool)?,
            pr_number: v.get("prNumber").and_then(Value::as_u64),
            pr_fixes_issue: v.get("prFixesIssue").and_then(Value::as_bool),
            pr_summary: v
                .get("prSummary")
                .and_then(Value::as_str)
                .map(str::to_string),
            recommendation: v.get("recommendation").and_then(Value::as_str)?.to_string(),
        })
    }
}

/// The single structured verdict a validation session emits, persisted (the stored
/// twin of the contract `IssueValidationResult`). Enum-typed axes are kept as wire
/// strings; `relatedFiles` are the engine-grounded (only-existing) repo-relative
/// paths. `reasoning`/`proposedPlan`/`prAnalysis.prSummary` are model prose over
/// attacker-controlled input (untrusted).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "StoredIssueValidationResult.ts"))]
pub struct StoredIssueValidationResult {
    /// Wire `IssueKind` string (`bug_report`/`feature_request`/`question`/`unknown`).
    pub issue_kind: String,
    /// Wire `IssueVerdict` string (`valid`/`invalid`/`needs_clarification`).
    pub verdict: String,
    /// Wire `IssueConfidence` string (`high`/`medium`/`low`).
    pub confidence: String,
    pub reasoning: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bug_confirmed: Option<bool>,
    #[serde(default)]
    pub related_files: Vec<String>,
    /// Wire `IssueComplexity` string (`trivial`…`very_complex`), when estimated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_complexity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposed_plan: Option<String>,
    #[serde(default)]
    pub missing_info: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_analysis: Option<StoredIssuePrAnalysis>,
}

impl StoredIssueValidationResult {
    /// Build a stored verdict from the `result` object of an
    /// `issue-validation-completed` event (camelCase wire keys), reading them
    /// directly so it never depends on the generated serde enums. Returns `None`
    /// when a required field (`issueKind`/`verdict`/`confidence`/`reasoning`) is
    /// missing — a partial verdict is dropped rather than persisted half-built.
    pub fn from_wire(v: &Value) -> Option<Self> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        let strings = |k: &str| {
            v.get(k)
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        };
        Some(Self {
            issue_kind: s("issueKind")?,
            verdict: s("verdict")?,
            confidence: s("confidence")?,
            reasoning: s("reasoning")?,
            bug_confirmed: v.get("bugConfirmed").and_then(Value::as_bool),
            related_files: strings("relatedFiles"),
            estimated_complexity: s("estimatedComplexity"),
            proposed_plan: s("proposedPlan"),
            missing_info: strings("missingInfo"),
            pr_analysis: v
                .get("prAnalysis")
                .and_then(StoredIssuePrAnalysis::from_wire),
        })
    }
}

/// One Issue Triage validation, persisted under `.nightcore/issue-validations/<id>.json`.
/// Reuses the Insight [`InsightUsage`] token totals so the scan/validation features
/// share one usage shape. The `result` is `None` while `running`/`failed` and present
/// once `completed`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "IssueValidationRun.ts"))]
pub struct IssueValidationRun {
    pub id: String,
    pub project_path: String,
    /// The validated issue's number.
    pub issue_number: u64,
    /// The issue title at validation time (untrusted; snapshotted for the history UI).
    pub issue_title: String,
    /// `running` | `completed` | `failed`.
    pub status: String,
    pub model: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub cost_usd: f64,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub usage: InsightUsage,
    /// The single grounded verdict; present once the validation completes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<StoredIssueValidationResult>,
    pub error: Option<String>,
    /// The board task this validation was converted into, if any (run-level convert —
    /// there is one verdict per run, so the link lives on the run, not a finding).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_task_id: Option<String>,
    /// Epoch-ms the user last opened this validation; `None` until first viewed. Drives
    /// the "new since you looked" affordance and never gates anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewed_at: Option<u64>,
    /// Epoch-ms of the last successful GitHub comment post from this validation; `None`
    /// until a post succeeds. Paired with [`Self::posted_comment_url`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub posted_at: Option<u64>,
    /// The `html_url` GitHub returned for the posted comment (best-effort), so the UI can
    /// deep-link it. `None` until a post succeeds (or when GitHub omitted the field).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub posted_comment_url: Option<String>,
}

/// The Issue Triage validation store: a [`RunStore`] over [`IssueValidationRun`]. The
/// generic run-level CRUD lives on `RunStore`; only the run-level convert link + the
/// viewed/posted stamps below are Issue-Triage-specific.
pub type IssueValidationStore = RunStore<IssueValidationRun>;

impl PersistedRun for IssueValidationRun {
    const RUN_LABEL: &'static str = "issue validation";
    const DIR_LABEL: &'static str = "issue-validations";
    const INTERRUPTED_ERROR: &'static str = "interrupted (app restarted mid-validation)";

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

impl IssueValidationStore {
    /// Atomically link a validation run to a task under ONE lock: if it is already
    /// linked return [`LinkOutcome::AlreadyLinked`] (the caller discards its freshly
    /// minted task and returns the existing one); otherwise stamp the link and return
    /// [`LinkOutcome::Linked`]. Closes the convert-to-task TOCTOU at run granularity —
    /// the twin of `PrReviewStore::link_finding_task` but for a per-run verdict.
    pub fn link_validation_task(&self, run_id: &str, task_id: &str) -> Result<LinkOutcome, String> {
        let (outcome, _) = self.edit_run(run_id, |run| {
            if let Some(existing) = run.linked_task_id.as_deref() {
                return Ok(Edit::Skip(LinkOutcome::AlreadyLinked(existing.to_string())));
            }
            run.linked_task_id = Some(task_id.to_string());
            Ok(Edit::Commit(LinkOutcome::Linked))
        })?;
        Ok(outcome)
    }

    /// Unconditionally (re)point a validation run's convert link at `task_id` — the heal
    /// path for a dangling link (the previously-linked task was deleted out from under a
    /// lost race). Never the CAS `link_validation_task`, which would early-return
    /// `AlreadyLinked` and never heal.
    pub fn set_validation_linked_task(&self, run_id: &str, task_id: &str) -> Result<(), String> {
        self.mutate(run_id, |run| {
            run.linked_task_id = Some(task_id.to_string());
        })
        .map(|_| ())
    }

    /// Stamp the run as viewed-now (`viewed_at = now`), persisting it. Returns the updated
    /// run. Idempotent-ish: each open refreshes the marker.
    pub fn mark_viewed(&self, run_id: &str) -> Result<IssueValidationRun, String> {
        self.mutate(run_id, |run| {
            run.viewed_at = Some(crate::task::now_ms());
        })
    }

    /// Stamp a successful GitHub comment post onto the run (`posted_at = now`, and the
    /// returned comment URL when GitHub provided one), persisting it.
    pub fn mark_posted(&self, run_id: &str, comment_url: Option<String>) -> Result<(), String> {
        self.mutate(run_id, |run| {
            run.posted_at = Some(crate::task::now_ms());
            run.posted_comment_url = comment_url;
        })
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::run_store::MAX_RUNS;
    use tempfile::TempDir;

    fn store() -> (IssueValidationStore, TempDir) {
        let tmp = TempDir::new().expect("temp dir");
        let store = IssueValidationStore::load_from(tmp.path().join("issue-validations"));
        (store, tmp)
    }

    fn result() -> StoredIssueValidationResult {
        StoredIssueValidationResult {
            issue_kind: "bug_report".into(),
            verdict: "valid".into(),
            confidence: "high".into(),
            reasoning: "reproduced in the parser".into(),
            bug_confirmed: Some(true),
            related_files: vec!["src/parser.rs".into()],
            estimated_complexity: Some("moderate".into()),
            proposed_plan: Some("1. add a guard\n2. test it".into()),
            missing_info: vec![],
            pr_analysis: None,
        }
    }

    fn run(id: &str, status: &str) -> IssueValidationRun {
        IssueValidationRun {
            id: id.to_string(),
            project_path: "/proj".into(),
            issue_number: 42,
            issue_title: "Parser panics on empty input".into(),
            status: status.into(),
            model: "claude-opus-4-8".into(),
            created_at: 1,
            updated_at: 1,
            cost_usd: 0.0,
            duration_ms: 0,
            usage: InsightUsage::default(),
            result: None,
            error: None,
            linked_task_id: None,
            viewed_at: None,
            posted_at: None,
            posted_comment_url: None,
        }
    }

    #[test]
    fn upsert_get_list_reload_round_trip() {
        let (store, tmp) = store();
        let mut r = run("r1", "completed");
        r.result = Some(result());
        store.upsert(&r).unwrap();

        assert_eq!(store.get("r1").unwrap().issue_number, 42);
        assert_eq!(store.list().len(), 1);
        assert_eq!(
            store.get("r1").unwrap().result.as_ref().unwrap().verdict,
            "valid"
        );

        // Reload from disk reconstructs the run (verdict + grounded files intact).
        let reloaded = IssueValidationStore::load_from(tmp.path().join("issue-validations"));
        let got = reloaded.get("r1").expect("run reloads");
        assert_eq!(got.issue_title, "Parser panics on empty input");
        let res = got.result.expect("verdict reloads");
        assert_eq!(res.issue_kind, "bug_report");
        assert_eq!(res.related_files, vec!["src/parser.rs".to_string()]);
        assert_eq!(res.estimated_complexity.as_deref(), Some("moderate"));
    }

    #[test]
    fn viewed_posted_and_linked_fields_round_trip_through_disk() {
        let (store, tmp) = store();
        let mut r = run("r1", "completed");
        r.result = Some(result());
        store.upsert(&r).unwrap();

        store.mark_viewed("r1").unwrap();
        store
            .mark_posted(
                "r1",
                Some("https://github.com/o/r/issues/42#issuecomment-1".into()),
            )
            .unwrap();
        match store.link_validation_task("r1", "task-7").unwrap() {
            LinkOutcome::Linked => {}
            LinkOutcome::AlreadyLinked(_) => panic!("first link should be Linked"),
        }

        let reloaded = IssueValidationStore::load_from(tmp.path().join("issue-validations"));
        let got = reloaded.get("r1").expect("run reloads");
        assert!(got.viewed_at.is_some(), "viewed marker survives");
        assert!(got.posted_at.is_some(), "posted marker survives");
        assert_eq!(
            got.posted_comment_url.as_deref(),
            Some("https://github.com/o/r/issues/42#issuecomment-1")
        );
        assert_eq!(got.linked_task_id.as_deref(), Some("task-7"));
    }

    #[test]
    fn link_validation_task_is_atomic_and_idempotent() {
        let (store, _tmp) = store();
        store.upsert(&run("r1", "completed")).unwrap();

        // First link succeeds and stamps the task.
        match store.link_validation_task("r1", "task-1").unwrap() {
            LinkOutcome::Linked => {}
            LinkOutcome::AlreadyLinked(_) => panic!("first link should be Linked"),
        }
        assert_eq!(
            store.get("r1").unwrap().linked_task_id.as_deref(),
            Some("task-1")
        );

        // A second link (the losing race) returns the existing task id, no mutation.
        match store.link_validation_task("r1", "task-2").unwrap() {
            LinkOutcome::AlreadyLinked(existing) => assert_eq!(existing, "task-1"),
            LinkOutcome::Linked => panic!("second link must be AlreadyLinked"),
        }
        assert_eq!(
            store.get("r1").unwrap().linked_task_id.as_deref(),
            Some("task-1"),
            "the original link is preserved"
        );
    }

    #[test]
    fn deserializes_a_minimal_run_file_additively() {
        // A validation JSON written with only the required fields (no result/linked/
        // viewed/posted, no cost/usage) must still load — the additive Option/default
        // fields fill in. Guards the serde-ADDITIVE on-disk contract.
        let json = serde_json::json!({
            "id": "r1", "projectPath": "/proj", "issueNumber": 42,
            "issueTitle": "t", "status": "running", "model": "m",
            "createdAt": 1, "updatedAt": 1, "error": null
        });
        let run: IssueValidationRun = serde_json::from_value(json).expect("minimal run loads");
        assert!(run.result.is_none());
        assert!(run.linked_task_id.is_none());
        assert!(run.viewed_at.is_none());
        assert!(run.posted_at.is_none());
        assert!(run.posted_comment_url.is_none());
        assert_eq!(run.cost_usd, 0.0);
        assert_eq!(run.usage.input_tokens, 0);
    }

    #[test]
    fn from_wire_parses_a_complete_result_with_pr_analysis() {
        let v = serde_json::json!({
            "issueKind": "feature_request",
            "verdict": "valid",
            "confidence": "medium",
            "reasoning": "a reasonable ask",
            "relatedFiles": ["src/a.ts", 42, "src/b.ts"],
            "estimatedComplexity": "complex",
            "proposedPlan": "do the thing",
            "missingInfo": [],
            "prAnalysis": {
                "hasOpenPr": true,
                "prNumber": 9,
                "prFixesIssue": false,
                "prSummary": "close but incomplete",
                "recommendation": "pr_needs_work"
            }
        });
        let r = StoredIssueValidationResult::from_wire(&v).expect("parse");
        assert_eq!(r.issue_kind, "feature_request");
        assert_eq!(r.confidence, "medium");
        // A non-string element in `relatedFiles` is dropped, not fatal.
        assert_eq!(
            r.related_files,
            vec!["src/a.ts".to_string(), "src/b.ts".to_string()]
        );
        assert!(r.bug_confirmed.is_none(), "absent bugConfirmed ⇒ None");
        let pr = r.pr_analysis.expect("pr analysis parsed");
        assert!(pr.has_open_pr);
        assert_eq!(pr.pr_number, Some(9));
        assert_eq!(pr.recommendation, "pr_needs_work");
    }

    #[test]
    fn from_wire_returns_none_on_missing_required_field() {
        // Missing `reasoning` (required) ⇒ None, never a half-built verdict.
        let v = serde_json::json!({
            "issueKind": "bug_report", "verdict": "valid", "confidence": "high"
        });
        assert!(StoredIssueValidationResult::from_wire(&v).is_none());
    }

    #[test]
    fn from_wire_drops_an_incomplete_pr_analysis_without_failing() {
        // A prAnalysis missing its required `recommendation` is dropped (None), but the
        // rest of the verdict still parses (fail-open on the optional nested block).
        let v = serde_json::json!({
            "issueKind": "bug_report", "verdict": "valid", "confidence": "high",
            "reasoning": "r", "prAnalysis": { "hasOpenPr": true }
        });
        let r = StoredIssueValidationResult::from_wire(&v).expect("verdict still parses");
        assert!(
            r.pr_analysis.is_none(),
            "an incomplete prAnalysis is dropped"
        );
    }

    #[test]
    fn reap_running_marks_running_failed() {
        let (store, _tmp) = store();
        store.upsert(&run("r1", "running")).unwrap();
        store.upsert(&run("r2", "completed")).unwrap();
        store.reap_running();
        assert_eq!(store.get("r1").unwrap().status, "failed");
        assert!(store.get("r1").unwrap().error.is_some());
        assert_eq!(store.get("r2").unwrap().status, "completed", "untouched");
    }

    #[test]
    fn upsert_prunes_oldest_beyond_the_cap() {
        let (store, _tmp) = store();
        for i in 0..(MAX_RUNS + 3) {
            let mut r = run(&format!("r{i}"), "completed");
            r.created_at = i as u64;
            store.upsert(&r).unwrap();
        }
        assert_eq!(store.list().len(), MAX_RUNS, "capped at MAX_RUNS");
        assert!(store.get("r0").is_none(), "oldest pruned");
    }
}
