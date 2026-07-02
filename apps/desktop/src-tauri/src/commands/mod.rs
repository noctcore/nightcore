//! The Tauri command layer.
//!
//! Command handlers that legitimately depend on BOTH the persistence layer
//! ([`crate::store`]) and orchestration ([`crate::orchestration`]) live here, so
//! the `store/` modules can stay pure persistence leaves with no up-calls into
//! orchestration. Phase 2 moves the TASK, PROJECT, and SETTINGS command families
//! here.

pub mod policy;
pub mod project;
pub mod settings;
pub mod task;
pub mod worktree;
