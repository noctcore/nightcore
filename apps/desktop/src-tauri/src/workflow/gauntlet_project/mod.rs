//! The Structure-Lock Gauntlet (feature #3): a per-project, zero-agent-cost gate
//! that runs the TARGET project's OWN generated harness checks — its custom lint
//! plugin, an architecture-boundary check (dependency-cruiser / import rules), and
//! coverage thresholds — as a deterministic gate BEFORE the paid reviewer, and
//! again at merge. An agent literally cannot merge code that breaks the harness.
//!
//! This is the sibling of [`crate::gauntlet`] (the pre-merge readiness gauntlet),
//! but where that one DETECTS the project's tooling, this one is DRIVEN by an
//! explicit, opt-in config the lint-plugin generator (feature #2) writes alongside
//! the plugin: `.nightcore/harness.json`.
//!
//! Safety posture (false-positive gates are worse than no gate):
//!   - **Absent `.nightcore/harness.json` ⇒ skip ALL checks** (trivially passes),
//!     so existing projects are completely unaffected — every check is opt-in.
//!   - A malformed file (or a missing `checks` array) ⇒ warn-and-skip everything.
//!   - A malformed / un-runnable individual entry ⇒ warn-and-skip just that entry.
//!   - Checks run sequentially, stopping at the first failure (stop-at-first), each
//!     surfacing the exact command it ran so a human can reproduce it.
//!
//! Split by responsibility (as the analysis finding suggested): [`config`] parses
//! and plans `.nightcore/harness.json`, and [`runner`] sequences the checks,
//! folds in the task verify command, and renders the fix instruction. The facade
//! preserves the historical `crate::gauntlet_project::{run, run_from,
//! empty_pass, append_task_verify_command, fix_instruction}` paths.
//!
//! Drift-v1 (T15) adds two siblings: [`command_guard`] shape-validates a compiled
//! drift check's model-generated `command` at the arm gate (the security seam), and
//! [`drift`] is the EnforceRun that runs the ARMED checks and measures per-convention
//! drift (`run_with_drift`) — the same gate result plus `ConventionDrift` records.

mod command_guard;
mod config;
mod drift;
mod runner;

#[cfg(test)]
mod tests;

pub(crate) use command_guard::validate_check_command;
pub(crate) use config::{is_armable_kind, ARMABLE_CHECK_KINDS};
pub(crate) use drift::run_with_drift;
pub(crate) use runner::*;
