//! Replay a recorded **Insight scan** transcript through the reader's
//! `analysis-*` finalizer seam.
//!
//! A scan correlates by `runId` (not `sessionId`) and is owned by a separate store +
//! channel, so `sidecar::reader::handle_event` routes the whole family to
//! `sidecar::insight::handle_analysis_event` before the session-id correlation. That
//! handler forwards each event to `nc:insight` and delegates ALL persistence to
//! `AppHandle`-free functions — `StoredFinding::from_wire`, `ScanTelemetry::from_event`,
//! `InsightStore::accumulate_findings`, `reconcile_scan_history`, `finalize_scan_items`
//! — which we call here in the exact same order, driven from the checked-in transcript.
//! Only the `app.emit` forward (a pure passthrough, `AppHandle<Wry>`-bound) is modelled
//! as a recorded log entry rather than a real Tauri emit.

use serde_json::Value;
use tempfile::TempDir;

use crate::sidecar::scan::{finalize_scan_items, reconcile_scan_history, ScanTelemetry};
use crate::store::insight::{InsightRun, InsightStore, InsightUsage, StoredFinding};
use crate::store::run_store::PersistedRun;
use crate::store::TaskStore;

use super::replay::parse_transcript;

const RUN_ID: &str = "run-1";

/// A `runId`-correlated Insight replay harness: the real `InsightStore` (the run being
/// scanned) plus a `TaskStore` (so cross-run convert-history reconciliation can check
/// task liveness), rooted in one temp dir. Feeds `analysis-*` events through the
/// handler's finalizer path and records the routing decision per event.
struct ScanReplay {
    _tmp: TempDir,
    store: InsightStore,
    tasks: TaskStore,
    emitted: Vec<String>,
}

impl ScanReplay {
    /// Boot with the run persisted `running` — the state `start_analysis` leaves before
    /// any `analysis-*` event arrives.
    fn boot() -> Self {
        let tmp = TempDir::new().expect("temp dir");
        let store = InsightStore::load_from(tmp.path().join("insights"));
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

    /// Feed one `analysis-*` event. Mirrors `handle_analysis_event`: forward, then the
    /// intermediate accumulate / terminal finalize / failed arms.
    fn feed(&mut self, event: &Value) {
        let event_type = event["type"].as_str().unwrap_or("");
        let Some(run_id) = event.get("runId").and_then(Value::as_str) else {
            self.emitted.push(format!("{event_type}:drop-no-runid"));
            return;
        };
        match event_type {
            "analysis-completed" => {
                let mut findings = parse_findings(event);
                let dismissed = self.store.dismissed_fingerprints(Some(run_id));
                let converted = self.store.converted_fingerprints(Some(run_id));
                reconcile_scan_history(&mut findings, &dismissed, &converted, &self.tasks);
                let tel = ScanTelemetry::from_event(event);
                let count = findings.len();
                // The is-finalized guard makes a duplicate terminal a no-op; record which
                // side of it this event landed on (the finalizer's own dedup).
                let was_final = self
                    .store
                    .get(run_id)
                    .map(|r| r.is_finalized())
                    .unwrap_or(false);
                finalize_scan_items(&self.store, "insight", run_id, &tel, findings, |run| {
                    &mut run.findings
                });
                self.emitted.push(if was_final {
                    format!("{event_type}:noop-finalized")
                } else {
                    format!("{event_type}:finalize({count})")
                });
            }
            "analysis-category-completed" | "analysis-category-round-completed" => {
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
            "analysis-failed" => {
                let reason = crate::sidecar::scan::failure_reason(event);
                let _ = self.store.mutate(run_id, |run| {
                    run.status = "failed".to_string();
                    run.error = Some(reason.clone());
                });
                self.emitted.push(format!("{event_type}:mark-failed"));
            }
            // `analysis-started` / `analysis-category-started`: forwarded for the live
            // panel, no persistence.
            _ => self.emitted.push(format!("{event_type}:forward")),
        }
    }

    fn run(&self) -> InsightRun {
        self.store.get(RUN_ID).expect("run exists")
    }
}

fn parse_findings(event: &Value) -> Vec<StoredFinding> {
    event
        .get("findings")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(StoredFinding::from_wire).collect())
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

fn running_run(id: &str) -> InsightRun {
    InsightRun {
        id: id.to_string(),
        project_path: "/repo".to_string(),
        scope: "repo".to_string(),
        status: "running".to_string(),
        categories: vec!["architecture".into(), "bugs".into(), "security".into()],
        model: "claude-opus-4-8".to_string(),
        created_at: 1,
        updated_at: 1,
        cost_usd: 0.0,
        duration_ms: 0,
        usage: InsightUsage::default(),
        findings: Vec::new(),
        rounds_by_category: std::collections::HashMap::new(),
        error: None,
    }
}

#[test]
fn insight_transcript_accumulates_partials_then_finalizes() {
    let mut h = ScanReplay::boot();
    let events = parse_transcript(include_str!("fixtures/insight-scan.jsonl"));

    // Replay every event EXCEPT the terminal, then assert the running run has already
    // persisted the partial findings each category pass produced (so a cancel/crash
    // keeps paid work).
    let terminal_at = events.len() - 1;
    for event in &events[..terminal_at] {
        h.feed(event);
    }
    let mid = h.run();
    assert_eq!(
        mid.status, "running",
        "still running before the terminal event"
    );
    assert_eq!(
        mid.findings.len(),
        2,
        "both category passes' findings are accumulated"
    );
    assert!(
        mid.cost_usd > 0.0,
        "intermediate spend is accumulated for a crash-safe total"
    );

    // The terminal event finalizes the run with the authoritative, cross-category set.
    h.feed(&events[terminal_at]);
    let done = h.run();
    assert_eq!(done.status, "completed");
    assert_eq!(
        done.findings.len(),
        2,
        "the final deduped finding set is persisted"
    );
    assert!(
        done.findings.iter().all(|f| f.status == "open"),
        "every fresh finding lands open"
    );
    assert_eq!(
        done.cost_usd, 0.12,
        "the terminal telemetry is authoritative"
    );
    assert_eq!(done.duration_ms, 45_000);
    assert_eq!(done.usage.input_tokens, 5000);
    assert_eq!(done.usage.output_tokens, 1500);
    assert!(done.error.is_none());

    assert_eq!(
        h.emitted,
        vec![
            "analysis-started:forward",
            "analysis-category-started:forward",
            "analysis-category-completed:accumulate(0)",
            "analysis-category-started:forward",
            "analysis-category-completed:accumulate(1)",
            "analysis-category-started:forward",
            "analysis-category-completed:accumulate(1)",
            "analysis-completed:finalize(2)",
        ],
    );
}

#[test]
fn insight_transcript_carries_dismissed_history_across_runs() {
    // Cross-run lifecycle: a fingerprint the user dismissed in a PRIOR run stays
    // dismissed when a re-scan re-discovers it (`reconcile_scan_history` +
    // `accumulate_findings`' dismissed set), so it never re-surfaces `open` and gets
    // re-minted by convert-all.
    let mut h = ScanReplay::boot();
    let mut prior = running_run("prior-run");
    prior.status = "completed".to_string();
    prior.findings.push({
        let mut f = StoredFinding::from_wire(&serde_json::json!({
            "id": "old-1", "category": "bugs", "severity": "high", "effort": "small",
            "title": "Unawaited promise drops errors", "description": "d",
            "fingerprint": "bugs:src/handler.ts:unawaited-promise",
        }))
        .expect("valid wire finding");
        f.status = "dismissed".to_string();
        f
    });
    h.store.upsert(&prior).expect("seed prior dismissed run");

    for event in parse_transcript(include_str!("fixtures/insight-scan.jsonl")) {
        h.feed(&event);
    }

    let done = h.run();
    let unawaited = done
        .findings
        .iter()
        .find(|f| f.fingerprint == "bugs:src/handler.ts:unawaited-promise")
        .expect("the re-discovered finding is present");
    assert_eq!(
        unawaited.status, "dismissed",
        "a previously-dismissed fingerprint stays dismissed across a re-scan"
    );
    let authz = done
        .findings
        .iter()
        .find(|f| f.fingerprint == "security:src/routes/projects.ts:missing-authz")
        .expect("the new finding is present");
    assert_eq!(
        authz.status, "open",
        "a genuinely new finding still lands open"
    );
}

#[test]
fn insight_transcript_dedupes_a_redelivered_terminal() {
    // A duplicate `analysis-completed` (re-delivery / a terminal racing a refetch) is a
    // no-op under the finalizer's is-finalized guard: findings don't double and the
    // telemetry is not re-stamped.
    let mut h = ScanReplay::boot();
    let events = parse_transcript(include_str!("fixtures/insight-scan.jsonl"));
    for event in &events {
        h.feed(event);
    }
    let after_first = h.run();

    // Re-feed the terminal verbatim.
    h.feed(events.last().expect("a terminal event"));
    let after_dup = h.run();

    assert_eq!(
        after_dup.findings.len(),
        2,
        "the duplicate terminal does not double findings"
    );
    assert_eq!(
        after_dup.cost_usd, after_first.cost_usd,
        "telemetry is not re-stamped"
    );
    assert_eq!(
        h.emitted.last().map(String::as_str),
        Some("analysis-completed:noop-finalized"),
        "the second terminal is recorded as a dedup no-op"
    );
}
