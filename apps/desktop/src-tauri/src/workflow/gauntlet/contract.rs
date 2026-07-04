//! The wire-contract types the readiness gauntlet surfaces to the UI
//! (`GauntletStep` / `GauntletResult`) — serde + `ts-rs` mirrors only, no
//! plumbing. Shared with `contracts::ts_bindings` (the ts-rs export) and the
//! phase-2/3 siblings through the `crate::gauntlet` facade.

use serde::Serialize;
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

// `StepStatus` is the persisted step-outcome enum; it now lives in the leaf
// `store::types` module (it travels inside the stored `Task` via `StructureLockCheck`),
// and `GauntletStep` reads it back down from there.
use crate::store::types::StepStatus;

/// One detected check and how it went.
// `exit_code`/`output` are OMITTED when absent (`skip_serializing_if` + `default`),
// so the generated TS is `exitCode?: number` / `output?: string` — matching the
// prior hand-mirror's optional `exitCode?` and keeping `output` an optional add
// (the board reads `step.exitCode !== undefined`). Omitting the null is behavior-
// preserving: the prior interface never carried a `null` here.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "GauntletStep.ts"))]
pub struct GauntletStep {
    /// The logical name (`typecheck` / `lint` / `test` / `check` / `clippy`).
    pub name: String,
    /// The exact command line that was (or would be) run.
    pub command: String,
    pub status: StepStatus,
    /// The process exit code, when the step actually ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub exit_code: Option<i32>,
    /// Tail of combined stdout+stderr for a failing step (truncated; never logged).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub output: Option<String>,
}

/// The structured gauntlet result surfaced to the UI.
// `failed_step` is OMITTED when absent (`skip_serializing_if` + `default`), so the
// generated TS is `failedStep?: string` — matching the prior hand-mirror exactly
// (the board reads `result.failedStep ?? 'unknown'`). Omitting the null is
// behavior-preserving: the prior interface never carried a `null` here.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "GauntletResult.ts"))]
pub struct GauntletResult {
    /// True when every detected step passed (vacuously true when none exist).
    pub passed: bool,
    pub steps: Vec<GauntletStep>,
    /// The name of the first step that failed, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub failed_step: Option<String>,
}
