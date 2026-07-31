//! The portable Structure-Lock export writer (portable lock PR 3, #134; lint-meta
//! half #325) — NEW and SEPARATE from [`super::apply`], which stays frozen.
//!
//! Split into two concerns:
//! - [`writer`] — the staging-dir write path, the deterministic workflow/README
//!   templates, and the [`PortableLockExport`] result type.
//! - [`lint_meta`] — the portable lint-meta half (#325): collecting the APPLIED rule
//!   files off disk, emitting the rule registry, and translating the bundle manifest's
//!   `lint-meta` commands into the published-runner form.

mod lint_meta;
mod writer;

// Module facade: `commands.rs` imports `super::export::{write_portable_lock,
// PortableLockExport}` and `harness/mod.rs` re-exports the result type for the ts-rs
// aggregator, so both keep resolving after the split.
pub(super) use writer::write_portable_lock;
pub use writer::PortableLockExport;
