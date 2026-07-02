//! The M4 verification gate state machine: a completed build commits its work and
//! dispatches an independent reviewer; the reviewer's verdict routes to done,
//! bounded auto-fix, or a park-for-approval. Fail-safe throughout — an unparseable
//! verdict or a crashed reviewer never silently passes.
//!
//! Split by concern: [`verdict`] (pure parse + subtask merge), [`dispatch`]
//! (reviewer/fix sessions + the auto-fix budget), and [`handlers`] (build/review
//! completion + the Structure-Lock gate).

mod dispatch;
mod handlers;
mod verdict;

// Module facade: preserve the historical `verification::*` paths after the split so
// call sites elsewhere keep resolving unchanged — `reader.rs` imports
// `verification::{handle_build_completed, handle_review_completed}`, and
// `sidecar/mod.rs` re-exports `verification::{dispatch_reviewer_for, MAX_FIX_ATTEMPTS}`.
// Each glob carries its submodule's original visibility.
//
// `verdict`'s pure helpers are reached in-crate via `super::verdict` (handlers) and
// aren't part of the external contract, so this path-preserving re-export currently
// has no consumer — allow the unused-glob warning (sidecar/mod.rs:53 convention).
pub(crate) use dispatch::*;
pub(crate) use handlers::*;
#[allow(unused_imports)]
pub use verdict::*;
