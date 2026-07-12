//! Replay a recorded **PR review** transcript through the reader's `pr-review-*`
//! finalizer seam.
//!
//! Like Insight, a PR review correlates by `runId` and is owned by its own store +
//! channel, so `sidecar::reader::handle_event` routes the family to
//! `sidecar::pr_review::handle_pr_review_event`. That handler forwards each event to
//! `nc:pr-review` and delegates persistence to the SAME `AppHandle`-free scan
//! functions Insight uses (`StoredReviewFinding::from_wire`, `ScanTelemetry::from_event`,
//! `PrReviewStore::accumulate_findings`, `reconcile_scan_history`, `finalize_scan_items`)
//! plus the PR-review-specific verdict stamp inside the finalize closure. We drive that
//! exact path here from the checked-in transcript.

use serde_json::Value;
use tempfile::TempDir;

use crate::sidecar::scan::{finalize_scan_items, reconcile_scan_history, ScanTelemetry};
use crate::store::insight::InsightUsage;
use crate::store::pr_review::{PrReviewRun, PrReviewStore, StoredReviewFinding};
use crate::store::run_store::PersistedRun;
use crate::store::TaskStore;

use super::replay::parse_transcript;

const RUN_ID: &str = "run-pr1";

/// A `runId`-correlated PR-review replay harness: the real `PrReviewStore` plus a
/// `TaskStore` for convert-history reconciliation, rooted in one temp dir.
struct PrReviewReplay {
    _tmp: TempDir,
    store: PrReviewStore,
    tasks: TaskStore,
    emitted: Vec<String>,
}

impl PrReviewReplay {
    fn boot() -> Self {
        let tmp = TempDir::new().expect("temp dir");
        let store = PrReviewStore::load_from(tmp.path().join("pr-reviews"));
        let tasks = TaskStore::load_from(tmp.path().join("tasks"));
        store
            .upsert(&running_run(RUN_ID))
            .expect("seed running run");
        Self {
            store,
            tasks,
            emitted: Vec::new(),
            _tmp: tmp,
        }
    }

    /// Feed one `pr-review-*` event. Mirrors `handle_pr_review_event`.
    fn feed(&mut self, event: &Value) {
        let event_type = event["type"].as_str().unwrap_or("");
        let Some(run_id) = event.get("runId").and_then(Value::as_str) else {
            self.emitted.push(format!("{event_type}:drop-no-runid"));
            return;
        };
        match event_type {
            "pr-review-completed" => {
                let mut findings = parse_findings(event);
                let dismissed = self.store.dismissed_fingerprints(Some(run_id));
                let converted = self.store.converted_fingerprints(Some(run_id));
                reconcile_scan_history(&mut findings, &dismissed, &converted, &self.tasks);
                let tel = ScanTelemetry::from_event(event);
                let count = findings.len();
                let verdict = event
                    .get("verdict")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let verdict_reasoning = event
                    .get("verdictReasoning")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let verdict_clamped = event.get("verdictClamped").and_then(Value::as_bool);
                let clamp_reason = event
                    .get("clampReason")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let was_final = self
                    .store
                    .get(run_id)
                    .map(|r| r.is_finalized())
                    .unwrap_or(false);
                finalize_scan_items(
                    &self.store,
                    "pr-review",
                    run_id,
                    &tel,
                    findings,
                    move |run| {
                        run.verdict = verdict;
                        run.verdict_reasoning = verdict_reasoning;
                        run.verdict_clamped = verdict_clamped;
                        run.clamp_reason = clamp_reason;
                        &mut run.findings
                    },
                );
                self.emitted.push(if was_final {
                    format!("{event_type}:noop-finalized")
                } else {
                    format!("{event_type}:finalize({count})")
                });
            }
            "pr-review-lens-completed" | "pr-review-round-completed" => {
                let findings = parse_findings(event);
                let count = findings.len();
                let cost = event.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0);
                let (input, output) = usage_tokens(event);
                let dismissed = self.store.dismissed_fingerprints(Some(run_id));
                let _ = self
                    .store
                    .accumulate_findings(run_id, findings, &dismissed, cost, input, output);
                self.emitted
                    .push(format!("{event_type}:accumulate({count})"));
            }
            // `pr-review-started` / `pr-review-lens-started`: forwarded, no persistence.
            _ => self.emitted.push(format!("{event_type}:forward")),
        }
    }

    fn run(&self) -> PrReviewRun {
        self.store.get(RUN_ID).expect("run exists")
    }
}

fn parse_findings(event: &Value) -> Vec<StoredReviewFinding> {
    event
        .get("findings")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(StoredReviewFinding::from_wire)
                .collect()
        })
        .unwrap_or_default()
}

fn usage_tokens(event: &Value) -> (u64, u64) {
    let usage = event.get("usage");
    let token = |key: &str| {
        usage
            .and_then(|u| u.get(key))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    (token("inputTokens"), token("outputTokens"))
}

fn running_run(id: &str) -> PrReviewRun {
    PrReviewRun {
        id: id.to_string(),
        project_path: "/repo".to_string(),
        pr_number: 42,
        status: "running".to_string(),
        lenses: vec![
            "security".into(),
            "logic".into(),
            "structure".into(),
            "tests".into(),
            "contracts".into(),
        ],
        model: "claude-opus-4-8".to_string(),
        created_at: 1,
        updated_at: 1,
        cost_usd: 0.0,
        duration_ms: 0,
        usage: InsightUsage::default(),
        findings: Vec::new(),
        rounds_by_lens: std::collections::HashMap::new(),
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
fn pr_review_transcript_accumulates_then_finalizes_with_verdict() {
    let mut h = PrReviewReplay::boot();
    let events = parse_transcript(include_str!("fixtures/pr-review.jsonl"));

    // The security lens surfaces the finding mid-run; assert it is persisted into the
    // still-`running` run (crash-safety) before the terminal.
    let terminal_at = events.len() - 1;
    for event in &events[..terminal_at] {
        h.feed(event);
    }
    let mid = h.run();
    assert_eq!(mid.status, "running");
    assert_eq!(
        mid.findings.len(),
        1,
        "the security lens finding is accumulated"
    );

    // Terminal finalizes with the authoritative set + the synthesis verdict.
    h.feed(&events[terminal_at]);
    let done = h.run();
    assert_eq!(done.status, "completed");
    assert_eq!(done.findings.len(), 1);
    assert_eq!(done.findings[0].status, "open");
    assert_eq!(
        done.findings[0].fingerprint,
        "security:src/handler.ts:unsanitized-input"
    );
    assert_eq!(
        done.verdict.as_deref(),
        Some("needs_revision"),
        "the merge verdict is stamped"
    );
    assert_eq!(
        done.verdict_reasoning.as_deref(),
        Some("A high-severity injection remains unaddressed on the diff.")
    );
    assert_eq!(done.verdict_clamped, Some(false));
    assert_eq!(
        done.cost_usd, 0.12,
        "the terminal telemetry is authoritative"
    );
    assert_eq!(done.duration_ms, 45_000);
    assert!(done.error.is_none());

    // Emission sequence: every event forwarded, the five lens passes accumulating
    // (only security is non-empty), the terminal finalizing.
    assert_eq!(
        h.emitted,
        vec![
            "pr-review-started:forward",
            "pr-review-lens-started:forward",
            "pr-review-lens-completed:accumulate(1)",
            "pr-review-lens-started:forward",
            "pr-review-lens-completed:accumulate(0)",
            "pr-review-lens-started:forward",
            "pr-review-lens-completed:accumulate(0)",
            "pr-review-lens-started:forward",
            "pr-review-lens-completed:accumulate(0)",
            "pr-review-lens-started:forward",
            "pr-review-lens-completed:accumulate(0)",
            "pr-review-completed:finalize(1)",
        ],
    );
}

#[test]
fn pr_review_transcript_dedupes_a_redelivered_terminal() {
    // A duplicate `pr-review-completed` is a no-op under the is-finalized guard: the
    // findings don't double and the verdict/telemetry survive unchanged.
    let mut h = PrReviewReplay::boot();
    let events = parse_transcript(include_str!("fixtures/pr-review.jsonl"));
    for event in &events {
        h.feed(event);
    }
    let after_first = h.run();

    h.feed(events.last().expect("a terminal event"));
    let after_dup = h.run();

    assert_eq!(
        after_dup.findings.len(),
        1,
        "the duplicate terminal does not double findings"
    );
    assert_eq!(
        after_dup.verdict, after_first.verdict,
        "the verdict is not re-stamped"
    );
    assert_eq!(
        after_dup.cost_usd, after_first.cost_usd,
        "telemetry is not re-stamped"
    );
    assert_eq!(
        h.emitted.last().map(String::as_str),
        Some("pr-review-completed:noop-finalized"),
        "the second terminal is recorded as a dedup no-op"
    );
}
