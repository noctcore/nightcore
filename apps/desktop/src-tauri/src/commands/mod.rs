//! The Tauri command layer.
//!
//! Command handlers that legitimately depend on BOTH the persistence layer
//! ([`crate::store`]) and orchestration ([`crate::orchestration`]) live here, so
//! the `store/` modules can stay pure persistence leaves with no up-calls into
//! orchestration. Phase 2 moves the TASK and PROJECT command families here; the
//! `settings` family follows in a later pass.

pub mod project;
pub mod task;
