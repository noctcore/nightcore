//! M2 — autonomy + isolation (DESIGN seams, not yet wired).
//!
//! This module holds the **scaffolded seams** for the M2 layer specified in
//! `docs/arch/2026-06-21-m2-design.md`: the auto-loop coordinator, slot manager,
//! worktree isolation, dependency ordering, circuit breaker, and the provider
//! trait. Only the cheap, pure, fully-testable pieces are implemented here
//! (`deps`); the rest are signatures/skeletons with `TODO(m2)` markers so the
//! boundaries are reviewable before the behavior lands.
//!
//! Deliberately **not** registered in `lib.rs`: M1's command surface and runtime
//! behavior are untouched. Wiring these into `run()` is the M2 implementation's
//! job (see the ticket order at the end of the design doc). The module is still
//! compiled (and its unit tests run under `cargo test`) via the `#[cfg(test)]`
//! gate below, so the seams are kept honest without affecting the shipped app.

#![cfg_attr(not(test), allow(dead_code))]

pub mod deps;
pub mod provider;
pub mod slots;
