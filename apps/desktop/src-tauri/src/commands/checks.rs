//! The Checks Manager commands (Enforce stage, T7): read + edit the armed
//! Structure-Lock checks in the active project's `.nightcore/harness.json`, and run
//! them on demand.
//!
//! The armed-check EXECUTOR already exists (`workflow::gauntlet_project`) but had no
//! entry point outside task verification, and the armed set was write-only (you
//! could arm a check via `arm_harness_gauntlet_check` but never list/edit/disable/
//! remove it). These commands close both gaps:
//!
//!  - `list_armed_checks` — every check in the manifest (incl. disabled), each
//!    joined to its LAST on-demand result + the run-level summary.
//!  - `set_armed_check_enabled` / `update_armed_check` / `remove_armed_check` —
//!    edit an EXISTING check (the merge-by-name writers in
//!    [`crate::store::harness_manifest`]; arming a NEW check stays on the hardened
//!    `sidecar::harness::apply` path).
//!  - `run_armed_checks_now` — run the whole armed gauntlet against the active
//!    project root right now, persist the result as the last run, and return it.
//!
//! The manifest path is always resolved server-side from the active project — never
//! caller-supplied — so the webview cannot point an edit or run at an arbitrary
//! repo, mirroring the policy commands.

use std::collections::HashMap;

use serde::Serialize;
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;

use crate::store::checks_state::{read_last_run, write_last_run};
use crate::store::harness_manifest::{
    read_armed_checks, remove_check, set_check_enabled, update_check, ArmedCheckFile,
};
use crate::store::types::{ConventionDrift, StepStatus, StructureLockCheck, StructureLockResult};

/// One armed check as the Checks Manager renders it: its manifest descriptor plus
/// the outcome it had in the LAST on-demand run (`None` until it has run once, or
/// for a check added since the last run).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "ArmedCheck.ts"))]
pub struct ArmedCheck {
    pub name: String,
    pub kind: String,
    pub command: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub config_path: Option<String>,
    /// This check's outcome in the last on-demand run (matched by name), if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub last_result: Option<ArmedCheckOutcome>,
}

/// A check's outcome from the last on-demand run — the subset of a
/// [`StructureLockCheck`] the manager row shows (its identity comes from the
/// [`ArmedCheck`] it hangs off).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "ArmedCheckOutcome.ts"))]
pub struct ArmedCheckOutcome {
    /// `passed` | `failed` | `flaky` (`skipped` never occurs in full-run mode).
    pub status: StepStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub duration_ms: Option<u64>,
}

/// The run-level summary of the last on-demand run (the panel's banner).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "ArmedChecksLastRun.ts"))]
pub struct ArmedChecksLastRun {
    pub passed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub failed_check: Option<String>,
    /// When the run finished (ms since epoch).
    pub ran_at: u64,
}

/// The whole Checks Manager view: the armed checks (with folded last results) and
/// the last run's summary. Returned by every command so the panel updates from one
/// shape after any edit or run.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "ArmedChecksState.ts"))]
pub struct ArmedChecksState {
    pub checks: Vec<ArmedCheck>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub last_run: Option<ArmedChecksLastRun>,
    /// Drift-v1 (T15): per-convention drift from the LAST EnforceRun — one record per
    /// armed compiled check that carries a `conventionFingerprint`. Empty until an
    /// EnforceRun has run (or for a pre-drift last-run record). The UI joins these to
    /// the coverage panel by `conventionFingerprint` and derives `uncheckable` for
    /// conventions with no armed check.
    pub drift: Vec<ConventionDrift>,
}

impl ArmedCheckOutcome {
    fn from_check(c: &StructureLockCheck) -> Self {
        Self {
            status: c.status,
            exit_code: c.exit_code,
            output: c.output.clone(),
            duration_ms: c.duration_ms,
        }
    }
}

/// Project the manifest checks + the persisted last run into the web-facing view.
/// Pure (filesystem reads happen in the callers), so it is unit-testable.
fn build_state(
    files: Vec<ArmedCheckFile>,
    last: Option<(u64, StructureLockResult)>,
    drift: Vec<ConventionDrift>,
) -> ArmedChecksState {
    // Index last-run outcomes by check name for the fold.
    let outcomes: HashMap<&str, &StructureLockCheck> = last
        .as_ref()
        .map(|(_, r)| r.checks.iter().map(|c| (c.name.as_str(), c)).collect())
        .unwrap_or_default();

    let checks = files
        .into_iter()
        .map(|f| {
            let last_result = outcomes
                .get(f.name.as_str())
                .map(|c| ArmedCheckOutcome::from_check(c));
            ArmedCheck {
                name: f.name,
                kind: f.kind,
                command: f.command,
                enabled: f.enabled,
                timeout_ms: f.timeout_ms,
                config_path: f.config_path,
                last_result,
            }
        })
        .collect();

    let last_run = last.map(|(ran_at, r)| ArmedChecksLastRun {
        passed: r.passed,
        failed_check: r.failed_check,
        ran_at,
    });

    ArmedChecksState {
        checks,
        last_run,
        drift,
    }
}

/// Read the manifest + last-run record for `project_path` and project them.
fn state_for(project_path: &str) -> ArmedChecksState {
    let files = read_armed_checks(project_path);
    let (last, drift) = match read_last_run(project_path) {
        Some(r) => (Some((r.ran_at, r.result)), r.drift),
        None => (None, Vec::new()),
    };
    build_state(files, last, drift)
}

/// The active project's path via `try_state` (blocking-pool safe).
fn active_project_path(app: &AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let projects = app
        .try_state::<crate::project::ProjectStore>()
        .ok_or_else(|| "project store unavailable".to_string())?;
    projects
        .active()
        .map(|p| p.path)
        .ok_or_else(|| "no active project".to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// --- Commands ---------------------------------------------------------------

/// List the ACTIVE project's armed checks (incl. disabled), each folded with its
/// last on-demand result + the run-level summary.
#[tauri::command]
pub async fn list_armed_checks(app: AppHandle) -> Result<ArmedChecksState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = active_project_path(&app)?;
        Ok(state_for(&path))
    })
    .await
    .map_err(|e| format!("list armed checks failed to run: {e}"))?
}

/// Enable / disable one armed check by name (merge-by-key over the manifest).
#[tauri::command]
pub async fn set_armed_check_enabled(
    app: AppHandle,
    name: String,
    enabled: bool,
) -> Result<ArmedChecksState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = active_project_path(&app)?;
        set_check_enabled(&path, &name, enabled)?;
        Ok(state_for(&path))
    })
    .await
    .map_err(|e| format!("set armed check enabled failed to run: {e}"))?
}

/// Remove (disarm) one armed check by name.
#[tauri::command]
pub async fn remove_armed_check(app: AppHandle, name: String) -> Result<ArmedChecksState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = active_project_path(&app)?;
        remove_check(&path, &name)?;
        Ok(state_for(&path))
    })
    .await
    .map_err(|e| format!("remove armed check failed to run: {e}"))?
}

/// Edit an existing armed check identified by `original_name`. Validates the new
/// `kind` against the armable allowlist and requires a non-empty name + command —
/// the same trusted-input discipline the arm command uses, so an edit can never
/// leave a check the gauntlet only warn-and-skips (a placebo gate).
#[tauri::command]
pub async fn update_armed_check(
    app: AppHandle,
    original_name: String,
    updated: ArmedCheckFile,
) -> Result<ArmedChecksState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = updated.name.trim();
        let command = updated.command.trim();
        if name.is_empty() {
            return Err("a check needs a name".to_string());
        }
        if command.is_empty() {
            return Err("a check needs a command to run".to_string());
        }
        if !crate::workflow::gauntlet_project::is_armable_kind(&updated.kind) {
            return Err(format!(
                "unknown check kind `{}` — a stray kind would arm a check the gauntlet only \
                 skips",
                updated.kind
            ));
        }
        // Drift-v1 (T15) security seam: a `lint-meta`/`shell` check's command is
        // model-generated, so shape-validate it (no shell metachars, allowlisted
        // executable) before an edit can land an injected/chained command. Single
        // source of truth shared with the arm gate.
        crate::workflow::gauntlet_project::validate_check_command(&updated.kind, command)?;
        // Normalize the trimmed name/command back onto the DTO before writing.
        let normalized = ArmedCheckFile {
            name: name.to_string(),
            command: command.to_string(),
            ..updated
        };
        let path = active_project_path(&app)?;
        update_check(&path, &original_name, &normalized)?;
        Ok(state_for(&path))
    })
    .await
    .map_err(|e| format!("update armed check failed to run: {e}"))?
}

/// Run the whole armed gauntlet against the ACTIVE project root right now, persist
/// the result as the last on-demand run, and return the refreshed view. Main-mode
/// shape (the project root is both the manifest root and the run dir); the runner
/// is full-run + per-check timeout + retry-once, so this can never hang the UI
/// unbounded. Runs on the blocking pool (it spawns subprocesses).
#[tauri::command]
pub async fn run_armed_checks_now(app: AppHandle) -> Result<ArmedChecksState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = active_project_path(&app)?;
        // Drift-v1 (T15): run the ARMED checks AND measure per-convention drift. The
        // gauntlet result is unchanged (main-mode: the project root is both manifest
        // root and run dir); `drift` is the new EnforceRun output.
        let root = std::path::Path::new(&path);
        let (result, drift) = crate::workflow::gauntlet_project::run_with_drift(root, root);
        // Best-effort persist — a failed write must not lose the just-computed result,
        // so we still return it (the panel just won't have it on the next cold mount).
        if let Err(e) = write_last_run(&path, &result, &drift, now_ms()) {
            tracing::warn!(target: "nightcore::checks_manager", error = %e, "could not persist last armed-checks run");
        }
        Ok(state_for(&path))
    })
    .await
    .map_err(|e| format!("run armed checks failed to run: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, enabled: bool) -> ArmedCheckFile {
        ArmedCheckFile {
            name: name.into(),
            kind: "lint-plugin".into(),
            command: "npx eslint .".into(),
            enabled,
            timeout_ms: None,
            config_path: None,
            convention_fingerprint: None,
        }
    }

    fn check(name: &str, status: StepStatus) -> StructureLockCheck {
        StructureLockCheck {
            name: name.into(),
            kind: "lint-plugin".into(),
            command: "npx eslint .".into(),
            status,
            exit_code: Some(if status == StepStatus::Failed { 1 } else { 0 }),
            output: None,
            duration_ms: Some(500),
        }
    }

    #[test]
    fn build_state_folds_last_results_by_name() {
        let files = vec![file("lint", true), file("arch", false), file("new", true)];
        let last = StructureLockResult {
            passed: false,
            failed_check: Some("lint".into()),
            checks: vec![
                check("lint", StepStatus::Failed),
                check("arch", StepStatus::Passed),
            ],
        };
        let state = build_state(files, Some((1234, last)), Vec::new());
        assert_eq!(state.checks.len(), 3);
        let by = |n: &str| state.checks.iter().find(|c| c.name == n).unwrap();
        assert_eq!(
            by("lint").last_result.as_ref().unwrap().status,
            StepStatus::Failed
        );
        assert_eq!(
            by("arch").last_result.as_ref().unwrap().status,
            StepStatus::Passed
        );
        // A check with no matching last-run entry has no result.
        assert!(by("new").last_result.is_none());
        assert!(!by("arch").enabled, "the disabled check is still listed");
        let run = state.last_run.unwrap();
        assert!(!run.passed);
        assert_eq!(run.failed_check.as_deref(), Some("lint"));
        assert_eq!(run.ran_at, 1234);
    }

    #[test]
    fn build_state_without_a_last_run_has_no_outcomes() {
        let state = build_state(vec![file("lint", true)], None, Vec::new());
        assert!(state.last_run.is_none());
        assert!(state.checks[0].last_result.is_none());
        assert!(state.drift.is_empty());
    }
}
