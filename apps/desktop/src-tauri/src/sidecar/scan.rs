//! Shared bridge helpers for the "scan" feature family (Insight, Readiness
//! Scorecard, Harness).
//!
//! All three features follow the same sidecar-bridge shape: a `start_*` command
//! persists a `running` run, ensures the sidecar reader is up, dispatches a
//! `SurfaceCommand`, and on failure marks the run `failed`; the reader-side
//! finalizer forwards raw events and, on the terminal `*-completed` event, extracts
//! the same cost/duration/token telemetry before folding it into the persisted run.
//!
//! This module owns every store-agnostic slice of that shape:
//!   - the `start_*` head — request validation + run-header resolution
//!     ([`begin_scan_run`]) and the dispatch tail ([`dispatch_scan_command`]);
//!   - the finalizer core — the idempotency guard and the status/telemetry stamp,
//!     unified in [`finalize_completed`] over the [`ScanRun`] / [`ScanStore`] traits,
//!     plus the shared wire helpers ([`ScanTelemetry`], [`failure_reason`], [`wire_str`]).
//!
//! Each feature injects only the parts that genuinely diverge: its run-struct shape
//! (scope vs dimensions vs profile/artifacts/synthesizing) and the `merge` closure that
//! rebuilds items from the wire event and reconciles in-run/cross-run lifecycle onto them.
//! The narrow [`ScanStore`] trait names JUST the `mutate(id, |run| …)` operation the
//! finalizer needs — deliberately not the full store trait (the store-trait refactor is a
//! separate finding) — so this unification lands without restructuring the three stores.

use serde::Serialize;
use serde_json::Value;

use crate::contracts::SurfaceCommand;
use crate::project::Project;
use crate::provider::SidecarProvider;
use crate::store::harness::{HarnessRun, HarnessStore, HarnessUsage};
use crate::store::insight::{InsightRun, InsightStore, InsightUsage};
use crate::store::scorecard::{ScorecardRun, ScorecardStore};
use crate::task::now_ms;

use super::ensure_reader;

/// Serialize a generated wire enum to its wire string (e.g. `AnalysisScope::Diff`
/// → `"diff"`, `ScorecardDimension::ErrorHandling` → `"error-handling"`,
/// `ConventionCategory::FolderStructure` → `"folder-structure"`). A value that
/// doesn't serialize to a JSON string yields an empty string.
pub(crate) fn wire_str<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// The cost/duration/token telemetry every scan's terminal `*-completed` event
/// carries. Extracted once here rather than re-parsed in each feature's finalizer.
pub(crate) struct ScanTelemetry {
    pub cost_usd: f64,
    pub duration_ms: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl ScanTelemetry {
    /// Pull `costUsd`, `durationMs`, and `usage.{inputTokens,outputTokens}` off a
    /// terminal event. Missing/mistyped fields default to `0` (a partial event
    /// finalizes with zeroed telemetry rather than being dropped).
    pub(crate) fn from_event(event: &Value) -> Self {
        let usage = event.get("usage");
        let token = |key: &str| {
            usage
                .and_then(|u| u.get(key))
                .and_then(Value::as_u64)
                .unwrap_or(0)
        };
        Self {
            cost_usd: event.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0),
            duration_ms: event.get("durationMs").and_then(Value::as_u64).unwrap_or(0),
            input_tokens: token("inputTokens"),
            output_tokens: token("outputTokens"),
        }
    }
}

/// Resolve the error string a `*-failed` event should persist: prefer a non-empty
/// `message`, fall back to `reason`, else `"unknown"`. Mirrors the fallback each
/// feature's failed-event arm applied by hand.
pub(crate) fn failure_reason(event: &Value) -> String {
    let message = event.get("message").and_then(Value::as_str).unwrap_or("");
    if !message.is_empty() {
        return message.to_string();
    }
    event
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

/// Drive the sidecar side of a scan `start_*` command: ensure the reader is up, then
/// dispatch `command`. On either failure, persist the run's failed-state via
/// `mark_failed` (a store `mutate` that sets `status = "failed"` + `error`) and, if
/// that persist itself fails, log the "run may look stuck on reload" warning. The
/// original dispatch error is returned unchanged so the command's `Result` is
/// identical to the hand-written flow it replaces.
///
/// `feature` is a static tag (`"insight"` / `"scorecard"` / `"harness"`) used only
/// in the persist-failure log line. `mark_failed` returns the store's own
/// `Result<_, String>`; only its `Err` is inspected here.
pub(crate) async fn dispatch_scan_command<F>(
    app: &tauri::AppHandle,
    feature: &'static str,
    run_id: &str,
    command: SurfaceCommand,
    mark_failed: F,
) -> Result<(), String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    use tauri::Manager;

    let result = async {
        ensure_reader(app).await?;
        let provider = app.state::<std::sync::Arc<SidecarProvider>>();
        provider.dispatch_command(command).await
    }
    .await;

    if let Err(e) = &result {
        if let Err(persist_err) = mark_failed(e) {
            tracing::warn!(
                target: "nightcore",
                feature,
                run_id,
                error = %persist_err,
                "failed to persist scan run failed-state (run may look stuck on reload)"
            );
        }
    }
    result
}

/// A persisted scan run that can be finalized on its terminal `*-completed` event.
/// Implemented by `InsightRun`, `ScorecardRun`, and `HarnessRun` so [`finalize_completed`]
/// can own the two store-agnostic halves of every completion arm — the idempotency guard
/// and the status/telemetry stamp — while each feature injects only its item rebuild and
/// lifecycle reconciliation.
pub(crate) trait ScanRun {
    /// Whether this run has ALREADY been finalized with results — the idempotency guard a
    /// duplicate `*-completed` must honor. Once a run is `completed` AND carries results,
    /// re-applying the terminal event would clobber the user's in-run lifecycle edits
    /// (dismiss / convert / apply). Deduplicated here so a fix to the guard lands in ONE
    /// place instead of three (the maintenance hazard this refactor exists to remove).
    fn is_finalized(&self) -> bool;

    /// Stamp the shared terminal state onto the run: `status = "completed"`, the
    /// cost/duration/token telemetry, and clear `error`. Feature-specific items
    /// (findings/readings/artifacts) and extras (harness's `profile` / `synthesizing`) are
    /// applied by the caller's `merge` closure BEFORE this runs.
    fn stamp_completion(&mut self, tel: &ScanTelemetry);
}

impl ScanRun for InsightRun {
    fn is_finalized(&self) -> bool {
        self.status == "completed" && !self.findings.is_empty()
    }
    fn stamp_completion(&mut self, tel: &ScanTelemetry) {
        self.status = "completed".to_string();
        self.cost_usd = tel.cost_usd;
        self.duration_ms = tel.duration_ms;
        self.usage = InsightUsage {
            input_tokens: tel.input_tokens,
            output_tokens: tel.output_tokens,
        };
        self.error = None;
    }
}

impl ScanRun for ScorecardRun {
    fn is_finalized(&self) -> bool {
        self.status == "completed" && !self.readings.is_empty()
    }
    fn stamp_completion(&mut self, tel: &ScanTelemetry) {
        self.status = "completed".to_string();
        self.cost_usd = tel.cost_usd;
        self.duration_ms = tel.duration_ms;
        // Scorecard reuses `InsightUsage` for its token totals.
        self.usage = InsightUsage {
            input_tokens: tel.input_tokens,
            output_tokens: tel.output_tokens,
        };
        self.error = None;
    }
}

impl ScanRun for HarnessRun {
    fn is_finalized(&self) -> bool {
        // A clean repo finalizes with zero findings but proposed artifacts (synthesis runs
        // regardless), so the guard checks BOTH collections — findings-only would miss that
        // case and let a duplicate completion clobber the applied artifacts.
        self.status == "completed" && (!self.findings.is_empty() || !self.artifacts.is_empty())
    }
    fn stamp_completion(&mut self, tel: &ScanTelemetry) {
        self.status = "completed".to_string();
        self.cost_usd = tel.cost_usd;
        self.duration_ms = tel.duration_ms;
        self.usage = HarnessUsage {
            input_tokens: tel.input_tokens,
            output_tokens: tel.output_tokens,
        };
        self.error = None;
    }
}

/// A scan store whose runs can be mutated by id — the ONE operation [`finalize_completed`]
/// needs. Each feature store already exposes `mutate(id, |run| …)` under a single lock;
/// this trait just names that shape so the finalizer is generic over all three. It is
/// intentionally minimal (not the full per-store surface — that broader store trait is a
/// separate finding), so unifying the finalizer doesn't wait on restructuring the stores.
pub(crate) trait ScanStore {
    type Run: ScanRun;
    fn mutate_run<F>(&self, run_id: &str, f: F) -> Result<Self::Run, String>
    where
        F: FnOnce(&mut Self::Run);
}

impl ScanStore for InsightStore {
    type Run = InsightRun;
    fn mutate_run<F>(&self, run_id: &str, f: F) -> Result<InsightRun, String>
    where
        F: FnOnce(&mut InsightRun),
    {
        self.mutate(run_id, f)
    }
}

impl ScanStore for ScorecardStore {
    type Run = ScorecardRun;
    fn mutate_run<F>(&self, run_id: &str, f: F) -> Result<ScorecardRun, String>
    where
        F: FnOnce(&mut ScorecardRun),
    {
        self.mutate(run_id, f)
    }
}

impl ScanStore for HarnessStore {
    type Run = HarnessRun;
    fn mutate_run<F>(&self, run_id: &str, f: F) -> Result<HarnessRun, String>
    where
        F: FnOnce(&mut HarnessRun),
    {
        self.mutate(run_id, f)
    }
}

/// Finalize a scan run on its terminal `*-completed` event — the store-agnostic core every
/// feature's completion arm shares. Under the store's single mutate lock it: (1) runs the
/// shared idempotency guard ([`ScanRun::is_finalized`]) so a duplicate terminal event is a
/// no-op; (2) applies `merge` — the ONLY per-feature piece — which reconciles the caller's
/// already-parsed items (in-run / cross-run lifecycle) and assigns them onto the run; then
/// (3) stamps the shared status + telemetry ([`ScanRun::stamp_completion`]).
///
/// Returns `true` when the persist succeeded — the caller then logs its feature-shaped
/// completion line (findings vs readings vs findings+artifacts) — and `false` when it
/// failed, in which case the shared warn is logged here. A guard short-circuit still
/// persists successfully and returns `true`, matching the pre-refactor behavior of logging
/// completion even for a duplicate terminal event.
pub(crate) fn finalize_completed<S, F>(
    store: &S,
    feature: &'static str,
    run_id: &str,
    tel: &ScanTelemetry,
    merge: F,
) -> bool
where
    S: ScanStore,
    F: FnOnce(&mut S::Run),
{
    match store.mutate_run(run_id, |run| {
        if run.is_finalized() {
            return;
        }
        merge(run);
        run.stamp_completion(tel);
    }) {
        Ok(_) => true,
        Err(e) => {
            tracing::warn!(target: "nightcore", feature, run_id, error = %e, "failed to finalize scan run");
            false
        }
    }
}

/// The store-agnostic header every scan `start_*` command resolves before it can build and
/// persist its `running` run.
#[derive(Debug)]
pub(crate) struct ScanRunInit {
    /// Absolute path of the active project the scan runs against.
    pub project_path: String,
    /// Fresh run id the terminal + intermediate events correlate by.
    pub run_id: String,
    /// The requested model as a plain string (empty when the caller passed `None`).
    pub model: String,
    /// Creation timestamp, reused for both `created_at` and `updated_at`.
    pub now: u64,
}

/// Validate a scan `start_*` request and resolve its shared run header. Rejects an empty
/// selection (`empty_selection_msg`) and a missing active project (`no_project_msg`) with
/// the SAME precedence every feature applied by hand — selection first, then project — then
/// mints a fresh run id + timestamp. The per-feature `wire_str` mapping of the selection and
/// the run-struct construction stay in the caller because those shapes genuinely diverge
/// (scope vs dimensions vs profile/artifacts/synthesizing), so parameterizing them would
/// cost more closure plumbing than the ~6 shared header lines it saves.
pub(crate) fn begin_scan_run(
    active_project: Option<Project>,
    selection_empty: bool,
    empty_selection_msg: &'static str,
    no_project_msg: &'static str,
    model: Option<&str>,
) -> Result<ScanRunInit, String> {
    if selection_empty {
        return Err(empty_selection_msg.to_string());
    }
    let project = active_project.ok_or(no_project_msg)?;
    Ok(ScanRunInit {
        project_path: project.path,
        run_id: uuid::Uuid::new_v4().to_string(),
        model: model.unwrap_or_default().to_string(),
        now: now_ms(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::insight::StoredFinding;
    use serde_json::json;

    #[test]
    fn telemetry_reads_cost_duration_and_tokens() {
        let event = json!({
            "costUsd": 0.42,
            "durationMs": 1234,
            "usage": { "inputTokens": 100, "outputTokens": 25 },
        });
        let tel = ScanTelemetry::from_event(&event);
        assert_eq!(tel.cost_usd, 0.42);
        assert_eq!(tel.duration_ms, 1234);
        assert_eq!(tel.input_tokens, 100);
        assert_eq!(tel.output_tokens, 25);
    }

    #[test]
    fn telemetry_defaults_missing_fields_to_zero() {
        // A terminal event missing telemetry (or its `usage` block) finalizes with
        // zeroes rather than panicking or being dropped.
        let tel = ScanTelemetry::from_event(&json!({}));
        assert_eq!(tel.cost_usd, 0.0);
        assert_eq!(tel.duration_ms, 0);
        assert_eq!(tel.input_tokens, 0);
        assert_eq!(tel.output_tokens, 0);
    }

    #[test]
    fn failure_reason_prefers_message_then_reason_then_unknown() {
        assert_eq!(
            failure_reason(&json!({ "message": "boom", "reason": "aborted" })),
            "boom"
        );
        // Empty message falls through to reason.
        assert_eq!(
            failure_reason(&json!({ "message": "", "reason": "aborted" })),
            "aborted"
        );
        // Neither present ⇒ the "unknown" sentinel.
        assert_eq!(failure_reason(&json!({})), "unknown");
    }

    #[test]
    fn wire_str_serializes_string_enums_and_empties_non_strings() {
        // A plain string serializes to itself; a non-string value yields "".
        assert_eq!(wire_str(&"error-handling"), "error-handling");
        assert_eq!(wire_str(&42_u32), "");
    }

    /// A `running` insight run with no findings — the state every scan starts in.
    fn running_insight_run() -> InsightRun {
        InsightRun {
            id: "run-1".to_string(),
            project_path: "/repo".to_string(),
            scope: "repo".to_string(),
            status: "running".to_string(),
            categories: Vec::new(),
            model: String::new(),
            created_at: 1,
            updated_at: 1,
            cost_usd: 0.0,
            duration_ms: 0,
            usage: InsightUsage::default(),
            findings: Vec::new(),
            error: None,
        }
    }

    #[test]
    fn is_finalized_gates_only_on_completed_with_results() {
        let mut run = running_insight_run();
        // Running ⇒ not finalized (the completion arm must run).
        assert!(!run.is_finalized());
        // Completed but EMPTY ⇒ still not finalized: this is the first real completion
        // (a run persisted `running` then completed) — the guard must let it through so
        // its findings actually land.
        run.status = "completed".to_string();
        assert!(!run.is_finalized());
        // Completed WITH results ⇒ finalized: a duplicate terminal event is now a no-op.
        run.findings.push(
            StoredFinding::from_wire(&json!({
                "id": "f1", "category": "perf", "severity": "high", "effort": "low",
                "title": "t", "description": "d", "fingerprint": "fp",
            }))
            .expect("valid wire finding"),
        );
        assert!(run.is_finalized());
    }

    #[test]
    fn stamp_completion_sets_status_telemetry_and_clears_error() {
        let mut run = running_insight_run();
        run.error = Some("transient dispatch error".to_string());
        let tel = ScanTelemetry {
            cost_usd: 1.5,
            duration_ms: 900,
            input_tokens: 10,
            output_tokens: 3,
        };
        run.stamp_completion(&tel);
        assert_eq!(run.status, "completed");
        assert_eq!(run.cost_usd, 1.5);
        assert_eq!(run.duration_ms, 900);
        assert_eq!(run.usage.input_tokens, 10);
        assert_eq!(run.usage.output_tokens, 3);
        assert!(run.error.is_none(), "a stale error is cleared on completion");
    }

    #[test]
    fn begin_scan_run_rejects_empty_selection_first() {
        // Selection is validated BEFORE the project — even with a project present, an empty
        // selection yields the selection error (the precedence every feature used by hand).
        let err = begin_scan_run(
            Some(Project::new("p".to_string(), "/repo".to_string(), None)),
            true,
            "pick a lens",
            "no project",
            None,
        )
        .unwrap_err();
        assert_eq!(err, "pick a lens");
    }

    #[test]
    fn begin_scan_run_rejects_missing_project() {
        let err = begin_scan_run(None, false, "pick a lens", "no project", None).unwrap_err();
        assert_eq!(err, "no project");
    }

    #[test]
    fn begin_scan_run_resolves_header_for_a_valid_request() {
        let init = begin_scan_run(
            Some(Project::new("p".to_string(), "/abs/repo".to_string(), None)),
            false,
            "pick a lens",
            "no project",
            Some("opus"),
        )
        .expect("valid request resolves a header");
        assert_eq!(init.project_path, "/abs/repo");
        assert_eq!(init.model, "opus");
        assert!(!init.run_id.is_empty(), "a run id is minted");
        assert!(init.now > 0, "a timestamp is stamped");
    }

    #[test]
    fn begin_scan_run_defaults_absent_model_to_empty() {
        let init = begin_scan_run(
            Some(Project::new("p".to_string(), "/abs/repo".to_string(), None)),
            false,
            "pick a lens",
            "no project",
            None,
        )
        .expect("valid request");
        assert!(init.model.is_empty(), "None model becomes the empty string");
    }
}
