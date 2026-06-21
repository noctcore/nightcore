//! M2 — autonomy + isolation.
//!
//! This module implements the M2 layer specified in
//! `docs/arch/2026-06-21-m2-design.md`: the auto-loop [`coordinator`] (the single
//! stateful driver), the [`slots`] manager (lease-based concurrency + abort
//! handles), git [`worktree`] isolation, [`deps`] dependency ordering, the
//! failure [`breaker`] (consecutive-failure circuit breaker), and the [`provider`]
//! trait seam (the sidecar process boundary).
//!
//! The [`coordinator::Orchestrator`] is registered in `lib.rs` as managed state and
//! drives the M2 commands (`start_auto_loop` / `stop_auto_loop` /
//! `resume_auto_loop` / `set_max_concurrency`) and the `nc:loop` event. M1's
//! command surface and serial single-run behavior are preserved — `run_task` still
//! routes through the slot manager at the configured concurrency.

pub mod breaker;
pub mod coordinator;
pub mod deps;
pub mod provider;
pub mod slots;
pub mod worktree;
