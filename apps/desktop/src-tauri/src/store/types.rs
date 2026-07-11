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
    /// Failed on its first run but PASSED on a single automatic retry — a flake,
    /// not a real failure. Surfaced distinctly so a user can see an unreliable
    /// check, but treated as a PASS for the gate (it never flips `passed` or burns
    /// a fix session). Only the structure-lock armed-check runner
    /// ([`crate::workflow::gauntlet_project`]) produces this; the readiness
    /// gauntlet never retries. Additive wire variant (`"flaky"`): pre-flaky
    /// on-disk tasks never carry it, so they deserialize unchanged.
    Flaky,
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
    /// Wall-clock the check took, in milliseconds (summed across the retry attempt
    /// when the check is `flaky`). Absent for a check that never ran (`skipped`).
    /// Additive: pre-duration on-disk tasks deserialize with `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub duration_ms: Option<u64>,
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

/// Drift-v1 (T15): one convention's MEASURED conformance, the output of an
/// EnforceRun executing its armed check. The Rust serde+ts-rs mirror of the zod
/// `ConventionDriftSchema` (`@nightcore/contracts` `harness-enforce.ts`), the exact
/// counterpart to how [`crate::store::harness::wire::StoredRuleCoverageGap`] mirrors
/// the zod `RuleCoverageGap` — coverage answers "is there a rule?", drift answers "is
/// it FOLLOWED at every site?". Produced only by running a HUMAN-armed check, joined
/// back to its convention by `conventionFingerprint`.
///
/// Non-negotiable product rule (mirrored from the contract): `clean`/`drifted` are
/// NEVER emitted without a `method` + real site counts. A check whose output can't be
/// turned into confident counts is `errored` (fail-visible), not silently `clean`.
/// `status` rides as its wire string (`clean` | `drifted` | `uncheckable` |
/// `errored`) and `category` as a lenient `ConventionCategory` wire string — the web
/// casts both, matching the ENFORCE-lite coverage record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "ConventionDrift.ts"))]
pub struct ConventionDrift {
    /// Stable id (`drift-<conventionFingerprint>`; UI keys).
    pub id: String,
    /// The convention this measures — its `category | title` sha1 (the join key).
    pub convention_fingerprint: String,
    /// The convention's lens (a `ConventionCategory` wire string; the web casts it).
    /// Empty when an EnforceRun has no access to the scan's convention set (it reads
    /// only the manifest) — the UI backfills the real category via the fingerprint join.
    pub category: String,
    /// The convention, restated as the rule the armed check verifies (the check name).
    pub title: String,
    /// `clean` | `drifted` | `uncheckable` | `errored` (wire string; the web casts).
    pub status: String,
    /// ALWAYS rendered: the check name + tool/rule id that determined this (e.g.
    /// `lint-meta: folder-per-component`).
    pub method: String,
    /// Violating sites the armed check reported.
    #[serde(default)]
    pub sites_matched: u64,
    /// Sites the armed check examined (`0` ⇒ counts unknown → never `clean`).
    #[serde(default)]
    pub sites_checked: u64,
    /// The armed check that produced this drift record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub check_name: Option<String>,
    /// Populated for `errored` — why the check could not run / its output could not
    /// be turned into confident counts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub error_reason: Option<String>,
    /// Stable carry-forward key — `== conventionFingerprint` (v0.4 acknowledged-drift).
    pub fingerprint: String,
}
