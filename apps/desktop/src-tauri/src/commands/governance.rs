//! The project trust dashboard commands (issue #399) — thin shells over
//! `crate::workflow::project_trust`.
//!
//! Each resolves the ACTIVE project server-side (never a caller-supplied path, so
//! the webview cannot point the reader at an arbitrary repo — the `commands::policy`
//! posture), reads the task store, the flight-recorder ledgers and the governance
//! journal, and returns the COMPUTED summary. Nothing here persists the summary.
//!
//! The bodies read one file per task ledger, so they run on the blocking pool via
//! `spawn_blocking` — a synchronous `#[tauri::command]` would freeze the WKWebView
//! for the read (`reference_tauri_command_threading`). State is re-acquired with
//! `try_state` inside the 'static closure (a `State<'_>` guard cannot cross into
//! it), so an unmanaged store fails gracefully.

use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::infra::path_confine::validate_export_dest;
use crate::store::TaskStore;
use crate::workflow::project_trust::{badge_of, build_summary, ProjectTrustSummary};

/// The active project's path via `try_state` (blocking-pool safe).
fn active_project_path(app: &AppHandle) -> Result<String, String> {
    let projects = app
        .try_state::<crate::project::ProjectStore>()
        .ok_or_else(|| "project store unavailable".to_string())?;
    projects
        .active()
        .map(|p| p.path)
        .ok_or_else(|| "no active project".to_string())
}

/// Resolve the inputs and compute the summary. Shared by both read commands so the
/// dashboard and the exported badge are computed from ONE call path.
fn summary_blocking(app: &AppHandle) -> Result<ProjectTrustSummary, String> {
    let root = active_project_path(app)?;
    let root = Path::new(&root);
    // An unmanaged task store degrades to "no tasks" rather than dropping the whole
    // dashboard — the guardrail + journal halves are still real evidence.
    let tasks: Vec<crate::task::Task> = app
        .try_state::<TaskStore>()
        .map(|store| store.list().iter().map(|t| (**t).clone()).collect())
        .unwrap_or_default();
    Ok(build_summary(
        &tasks,
        &crate::store::ledger::ledger_dir(root),
        root,
        crate::task::now_ms(),
    ))
}

/// The ACTIVE project's governance posture: verified merges, gauntlet pass rate,
/// guardrail denials, spend, and the governance journal rolled up.
#[tauri::command]
pub async fn project_trust_summary(app: AppHandle) -> Result<ProjectTrustSummary, String> {
    tauri::async_runtime::spawn_blocking(move || summary_blocking(&app))
        .await
        .map_err(|e| format!("project trust summary failed to run: {e}"))?
}

/// The shields.io endpoint payload for the ACTIVE project, as pretty JSON — the
/// bytes a repo publishes so `https://img.shields.io/endpoint?url=…` renders its
/// governance posture. Derived from the same summary the dashboard renders.
#[tauri::command]
pub async fn governance_badge_json(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let summary = summary_blocking(&app)?;
        badge_json(&summary)
    })
    .await
    .map_err(|e| format!("governance badge failed to run: {e}"))?
}

/// Write the badge JSON to a user-chosen path (the native save dialog supplies it).
///
/// `dest_path` is USER-CHOSEN and untrusted: it must be absolute and must not
/// descend through any `.nightcore/` directory
/// ([`validate_export_dest`]) — a badge written over
/// `.nightcore/ledger/project.ndjson` would destroy the journal it reports on. The
/// bytes are rendered here (one canonical serializer) and written atomically via
/// `store::write_atomic`, the `write_trust_report` idiom.
#[tauri::command]
pub async fn write_governance_badge(app: AppHandle, dest_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = validate_export_dest(&dest_path)?;
        let summary = summary_blocking(&app)?;
        let json = badge_json(&summary)?;
        crate::store::write_atomic(&dest, json.as_bytes()).map_err(|e| {
            format!(
                "failed to write the governance badge to {}: {e}",
                dest.display()
            )
        })
    })
    .await
    .map_err(|e| format!("write governance badge failed to run: {e}"))?
}

/// Serialize the summary's badge as the shields endpoint payload. The ONE
/// serializer — the clipboard copy and the file export render identical bytes.
fn badge_json(summary: &ProjectTrustSummary) -> Result<String, String> {
    serde_json::to_string_pretty(badge_of(summary))
        .map_err(|e| format!("failed to serialize the governance badge: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The published bytes are the shields ENDPOINT contract: `schemaVersion` (not
    /// `schema_version`), `label`, `message`, `color`. A rename here silently breaks
    /// every badge already pointed at a published file, so pin it.
    #[test]
    fn the_badge_serializes_as_a_shields_endpoint_payload() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let root = tmp.path();
        let summary = crate::workflow::project_trust::build_summary(
            &[],
            &crate::store::ledger::ledger_dir(root),
            root,
            0,
        );

        let json = badge_json(&summary).expect("serialize");
        let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["label"], "governance");
        assert_eq!(value["message"], "not measured");
        assert_eq!(value["color"], "lightgrey");
        assert_eq!(
            value.as_object().expect("object").len(),
            4,
            "the endpoint payload carries exactly the four shields keys: {json}"
        );
    }
}
