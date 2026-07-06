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
//!     unified in [`finalize_completed`] over the store-layer
//!     [`PersistedRun`] trait (the former `ScanRun`/`ScanStore` pair was folded into
//!     it — audit #34), plus the shared wire helpers ([`ScanTelemetry`],
//!     [`failure_reason`], [`wire_str`]).
//!
//! Each feature injects only the parts that genuinely diverge: its run-struct shape
//! (scope vs dimensions vs profile/artifacts/synthesizing) and the `merge` closure that
//! rebuilds items from the wire event and reconciles in-run/cross-run lifecycle onto them.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;

use crate::contracts::SurfaceCommand;
use crate::project::Project;
use crate::provider::SidecarProvider;
use crate::store::run_store::{LifecycleItem, PersistedRun, RunStore};
use crate::store::TaskStore;
use crate::task::{now_ms, TaskStatus};

use super::ensure_reader;

/// Generate the four store-agnostic lifecycle `#[tauri::command]`s every scan feature
/// (Insight / Scorecard / Harness) exposes identically: `list` (all runs, newest
/// first), `get` (one by id), `delete` (drop a run + its file), and `cancel` (dispatch
/// the feature's cancel `SurfaceCommand`). Tauri commands can't be generic (the
/// `generate_handler!` macro needs concrete fns), so this macro stamps the four
/// concrete fns from one declaration instead of hand-copying them per feature —
/// collapsing the previously-triplicated boilerplate into a single scan-kind surface.
///
/// The feature's `start_*` and its convert/apply commands stay hand-written: their
/// bodies genuinely diverge (per-feature run struct, dispatch payload, and
/// convert-to-task / write-artifact logic), and `start_*` already routes its shared
/// slice through [`begin_scan_run`] / [`dispatch_scan_command`].
///
/// Invoke ONE per feature at module scope; the caller supplies the exact command
/// names so `generate_handler!` (via the `sidecar::*` glob re-export) still resolves
/// them by their historical paths. The store is reached as managed [`tauri::State`]
/// (resolved by type, so its binding name is irrelevant) and must expose the
/// [`RunStore`](crate::store::run_store::RunStore) `list`/`get`/`remove` surface.
///
/// Two arms: the full surface (list/get/delete + the shared dispatch-only cancel),
/// and a cancel-less surface for a kind whose cancel needs feature-specific store
/// marking before the dispatch (PR review's setup-window cancel — see
/// `cancel_pr_review`) and so stays hand-written. The full arm recurses into the
/// cancel-less one, so the three shared commands exist in exactly one place.
macro_rules! scan_lifecycle_commands {
    (
        store: $Store:ty,
        run: $Run:ty,
        list: $list:ident,
        get: $get:ident,
        delete: $delete:ident,
        cancel: $cancel:ident,
        cancel_command: $cancel_variant:ident,
        item: $item:literal $(,)?
    ) => {
        scan_lifecycle_commands! {
            store: $Store,
            run: $Run,
            list: $list,
            get: $get,
            delete: $delete,
            item: $item,
        }

        #[doc = concat!("Cancel an in-flight ", $item, " run (aborts every pass).")]
        #[tauri::command]
        pub async fn $cancel(app: tauri::AppHandle, run_id: String) -> Result<(), String> {
            use tauri::Manager;
            let provider = app.state::<std::sync::Arc<crate::provider::SidecarProvider>>();
            let command = crate::contracts::SurfaceCommand::$cancel_variant {
                run_id: run_id.clone(),
            };
            provider.dispatch_command(command).await
        }
    };
    (
        store: $Store:ty,
        run: $Run:ty,
        list: $list:ident,
        get: $get:ident,
        delete: $delete:ident,
        item: $item:literal $(,)?
    ) => {
        #[doc = concat!("All ", $item, " runs for the active project (newest first).")]
        #[tauri::command]
        pub fn $list(store: tauri::State<'_, $Store>) -> Result<Vec<$Run>, String> {
            Ok(store.list())
        }

        #[doc = concat!("One ", $item, " run by id.")]
        #[tauri::command]
        pub fn $get(
            store: tauri::State<'_, $Store>,
            run_id: String,
        ) -> Result<Option<$Run>, String> {
            Ok(store.get(&run_id))
        }

        #[doc = concat!("Delete a ", $item, " run and its file.")]
        #[tauri::command]
        pub fn $delete(store: tauri::State<'_, $Store>, run_id: String) -> Result<(), String> {
            store.remove(&run_id)
        }
    };
}
pub(crate) use scan_lifecycle_commands;

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

/// Finalize a scan run on its terminal `*-completed` event — the store-agnostic core every
/// feature's completion arm shares. Under the store's single mutate lock it: (1) runs the
/// shared idempotency guard ([`PersistedRun::is_finalized`]) so a duplicate terminal event
/// is a no-op; (2) applies `merge` — the ONLY per-feature piece — which reconciles the
/// caller's already-parsed items (in-run / cross-run lifecycle) and assigns them onto the
/// run; then (3) stamps the shared status + telemetry (`completed`, cleared error,
/// [`PersistedRun::set_telemetry`]).
///
/// Returns `true` when the persist succeeded — the caller then logs its feature-shaped
/// completion line (findings vs readings vs findings+artifacts) — and `false` when it
/// failed, in which case the shared warn is logged here. A guard short-circuit still
/// persists successfully and returns `true`, matching the pre-refactor behavior of logging
/// completion even for a duplicate terminal event.
pub(crate) fn finalize_completed<R, F>(
    store: &RunStore<R>,
    feature: &'static str,
    run_id: &str,
    tel: &ScanTelemetry,
    merge: F,
) -> bool
where
    R: PersistedRun,
    F: FnOnce(&mut R),
{
    match store.mutate(run_id, |run| {
        if run.is_finalized() {
            return;
        }
        merge(run);
        run.set_status("completed");
        run.set_telemetry(
            tel.cost_usd,
            tel.duration_ms,
            tel.input_tokens,
            tel.output_tokens,
        );
        run.set_error(None);
    }) {
        Ok(_) => true,
        Err(e) => {
            tracing::warn!(target: "nightcore", feature, run_id, error = %e, "failed to finalize scan run");
            false
        }
    }
}

/// The cross-run lifecycle reconciliation the Insight and PR-Review completion arms share
/// (Scorecard has none — every grade is a fresh snapshot), applied to the freshly-parsed
/// terminal items BEFORE they are finalized:
///   - a re-discovered item whose fingerprint was previously DISMISSED stays dismissed;
///   - a still-`open` item whose fingerprint was already CONVERTED in a prior run stays
///     `converted` + linked WHEN its task still exists and isn't `Done` — so a re-scan
///     doesn't re-surface it `open` and re-mint a duplicate task via convert-all.
///
/// The dismissed pass runs FIRST so a now-dismissed item is never re-considered for convert
/// (it is no longer `open`), matching the hand-written order this replaces. The `converted`
/// map is consulted only when non-empty, so the task-store lookups are skipped otherwise.
pub(crate) fn reconcile_scan_history<I: LifecycleItem>(
    items: &mut [I],
    dismissed: &HashSet<String>,
    converted: &HashMap<String, String>,
    task_store: &TaskStore,
) {
    for item in items.iter_mut() {
        if dismissed.contains(item.fingerprint()) {
            item.set_status("dismissed");
        }
    }
    if converted.is_empty() {
        return;
    }
    for item in items.iter_mut() {
        if item.status() != "open" {
            continue;
        }
        if let Some(task_id) = converted.get(item.fingerprint()) {
            if let Some(task) = task_store.get(task_id) {
                if task.status != TaskStatus::Done {
                    item.set_status("converted");
                    item.set_linked_task_id(Some(task_id.clone()));
                }
            }
        }
    }
}

/// Finalize a scan run whose completion arm rebuilds a single item collection (Insight
/// findings, PR-Review findings, Scorecard readings) — the last-mile twin of
/// [`finalize_completed`] that also owns the by-fingerprint IN-RUN lifecycle carry-forward
/// those three arms applied identically. Under the finalize lock it merges `items` onto the
/// run, preserving any non-`open` lifecycle (a dismiss / convert / harden the user applied
/// to a peeked item DURING the run) by fingerprint so the wholesale replace doesn't reset it
/// to `open`, then stamps completion. `select` picks the run's item `Vec`. Returns
/// [`finalize_completed`]'s persisted flag for the caller's feature-shaped log line.
pub(crate) fn finalize_scan_items<R, I, Sel>(
    store: &RunStore<R>,
    feature: &'static str,
    run_id: &str,
    tel: &ScanTelemetry,
    items: Vec<I>,
    select: Sel,
) -> bool
where
    R: PersistedRun,
    I: LifecycleItem,
    Sel: FnOnce(&mut R) -> &mut Vec<I>,
{
    finalize_completed(store, feature, run_id, tel, move |run| {
        let dest = select(run);
        let prior: HashMap<String, (String, Option<String>)> = dest
            .iter()
            .filter(|item| item.status() != "open")
            .map(|item| {
                (
                    item.fingerprint().to_string(),
                    (
                        item.status().to_string(),
                        item.linked_task_id().map(str::to_string),
                    ),
                )
            })
            .collect();
        let mut merged = items;
        for item in &mut merged {
            if let Some((status, link)) = prior.get(item.fingerprint()) {
                item.set_status(status);
                item.set_linked_task_id(link.clone());
            }
        }
        *dest = merged;
    })
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
    use crate::store::insight::{InsightRun, InsightUsage, StoredFinding};
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
    fn completion_stamp_sets_status_telemetry_and_clears_error() {
        // The exact stamp `finalize_completed` applies on a terminal event
        // (status → completed, telemetry overwritten, stale error cleared).
        let mut run = running_insight_run();
        run.error = Some("transient dispatch error".to_string());
        let tel = ScanTelemetry {
            cost_usd: 1.5,
            duration_ms: 900,
            input_tokens: 10,
            output_tokens: 3,
        };
        run.set_status("completed");
        run.set_telemetry(
            tel.cost_usd,
            tel.duration_ms,
            tel.input_tokens,
            tel.output_tokens,
        );
        run.set_error(None);
        assert_eq!(run.status, "completed");
        assert_eq!(run.cost_usd, 1.5);
        assert_eq!(run.duration_ms, 900);
        assert_eq!(run.usage.input_tokens, 10);
        assert_eq!(run.usage.output_tokens, 3);
        assert!(
            run.error.is_none(),
            "a stale error is cleared on completion"
        );
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
