//! Orchestration — the run engine: autonomy + isolation.
//!
//! This module implements the run engine originally specified as the "M2 layer"
//! in `docs/arch/2026-06-21-m2-design.md`: the auto-loop [`coordinator`] (the single
//! stateful driver), the [`slots`] manager (lease-based concurrency + abort
//! handles), git [`crate::worktree`] isolation, [`deps`] dependency ordering, the
//! failure [`breaker`] (consecutive-failure circuit breaker). The provider seam
//! (the sidecar process boundary) lives in the top-level [`crate::provider`] module,
//! a peer both the engine and the bridge depend on.
//!
//! The [`coordinator::Orchestrator`] is registered in `lib.rs` as managed state and
//! drives the auto-loop commands (`start_auto_loop` / `stop_auto_loop` /
//! `resume_auto_loop` / `set_max_concurrency`) and the `nc:loop` event. The original
//! command surface and serial single-run behavior are preserved — `run_task` still
//! routes through the slot manager at the configured concurrency.

pub mod breaker;
pub mod coordinator;
pub mod deps;
pub mod slots;

mod engine_handle;

// The engine-side adapter for the bridge's `crate::engine_api::EngineApi` seam.
// Re-exported so `lib.rs` can manage it as `crate::orchestration::EngineHandle`
// without naming the submodule path.
pub(crate) use engine_handle::EngineHandle;
