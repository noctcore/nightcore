//! Pre-merge readiness gauntlet (M4 §C).
//!
//! A deterministic, zero-agent-cost detector + runner over a task's worktree. It
//! NEVER invents commands: it detects the project's real tooling (npm/bun scripts,
//! or Cargo) and runs only what exists, **stopping at the first failure**. The
//! result gates `merge_task` — the one irreversible action — but not `commit_task`
//! (committing in the isolated worktree is reversible).
//!
//! Split by concern (mirrors the `pr/` arc): [`contract`] holds the serde/ts-rs
//! wire types, [`detect`] the tooling probe, [`run`] the sequential runner +
//! failure-output truncation, and [`command`] the `#[tauri::command]` entry
//! point. The facade re-exports preserve the historical `crate::gauntlet::*`
//! paths (`run`/`empty_pass`/`GauntletResult`/`GauntletStep`/`run_gauntlet`) so
//! external call sites resolve unchanged. The shared output-truncation helper now
//! lives in `crate::infra::text::tail_output` (issue #17 phase A.3).

mod command;
mod contract;
mod detect;
mod run;

#[cfg(test)]
mod tests;

pub(crate) use command::*;
pub(crate) use contract::*;
pub(crate) use run::*;
