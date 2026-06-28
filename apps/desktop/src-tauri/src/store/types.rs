//! Leaf data types persisted on the `Task` model.
//!
//! Home of the structure-lock result cluster (`StepStatus` →
//! [`StructureLockCheck`] → [`StructureLockResult`]) that travels inside the
//! persisted `Task` JSON. This module imports nothing from the rest of the crate
//! — it is a dependency leaf — so the stored `Task` model can name the shapes it
//! persists without reaching up into the lifecycle modules that produce them.
//! Those gauntlet runners import these shapes back down from here, so there is no
//! cycle.
//!
//! These three types are the canonical definitions; their `ts-rs` bindings
//! (`StepStatus.ts`, `StructureLockCheck.ts`, `StructureLockResult.ts`) are
//! generated unchanged from here — relocating a type does not alter its
//! generated TS (that depends on the name/fields/derives/`export_to`, not the
//! Rust module path).

use serde::{Deserialize, Serialize};
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

/// The outcome of one gauntlet step.
// Also `Deserialize` because it travels (via `StructureLockCheck`) inside the
// persisted `Task` JSON, which round-trips through serde on store load.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, ts(export, export_to = "StepStatus.ts"))]
pub enum StepStatus {
    Passed,
    Failed,
    /// Detected but not run because an earlier step already failed (stop-at-first).
    Skipped,
}

/// The outcome of one structure-lock check — parallel to
/// [`crate::gauntlet::GauntletStep`], but carrying the harness `kind`.
//
// `exit_code`/`output` are OMITTED when absent (`skip_serializing_if` + `default`)
// so the generated TS is `exitCode?: number` / `output?: string`, matching the
// gauntlet's `GauntletStep` exactly.
// Also `Deserialize`: this travels inside the persisted `Task` JSON, which
// round-trips through serde when the store loads from disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "StructureLockCheck.ts"))]
pub struct StructureLockCheck {
    /// The logical name from the config (e.g. `folder-per-component`).
    pub name: String,
    /// The harness kind (`lint-plugin` / `dependency-cruiser` / `coverage-threshold`).
    pub kind: String,
    /// The exact command line that was (or would be) run.
    pub command: String,
    pub status: StepStatus,
    /// The process exit code, when the check actually ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub exit_code: Option<i32>,
    /// Tail of combined stdout+stderr for a failing check (truncated; never logged).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub output: Option<String>,
}

/// The structured structure-lock result surfaced to the UI and stored on the task
/// — parallel to [`crate::gauntlet::GauntletResult`].
//
// `failed_check` is OMITTED when absent so the generated TS is `failedCheck?:
// string`, matching the gauntlet's `failedStep?`.
// Also `Deserialize`: stored on the `Task` and round-tripped through serde on load.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "StructureLockResult.ts"))]
pub struct StructureLockResult {
    /// True when every enabled check passed (vacuously true when none exist / the
    /// config is absent).
    pub passed: bool,
    pub checks: Vec<StructureLockCheck>,
    /// The name of the first check that failed, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub failed_check: Option<String>,
}

impl StructureLockResult {
    /// A trivially-passing result (no config / no enabled checks).
    pub fn empty_pass() -> Self {
        Self {
            passed: true,
            checks: Vec::new(),
            failed_check: None,
        }
    }
}
