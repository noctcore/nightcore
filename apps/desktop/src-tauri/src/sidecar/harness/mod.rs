//! Harness (codebase convention auditor) commands + the reader-side handling of the
//! `harness-*` event family.
//!
//! Commands (web → Rust): `start_harness_scan` dispatches a `start-harness-scan`
//! `SurfaceCommand` to the sidecar (whose `SessionManager` detects the repo profile,
//! fans out the read-only convention passes, then synthesizes proposed artifacts) and
//! creates the persisted run; `cancel_harness_scan` aborts it; the rest are store
//! reads/mutations PLUS the one write-bearing command, `apply_harness_artifact`, which
//! writes a proposed artifact into the TARGET REPO. That write is the only place this
//! feature touches a user's files, so it is defended hard: the destination must resolve
//! inside the project root (lexical `..`/absolute rejection THEN a canonicalized
//! containment check that also defeats symlink escapes), `create` never clobbers an
//! existing file (`create_new`), and doc artifacts merge into a delimited managed block.
//!
//! Reader (sidecar → Rust): [`handle_harness_event`] forwards every `harness-*` event to
//! the `nc:harness` channel and, on `harness-scan-completed`, finalizes the persisted
//! run — carrying dismissed findings and applied/dismissed artifacts forward by
//! fingerprint so a re-scan doesn't reset the user's lifecycle edits.
//!
//! Split into three concerns: [`commands`] (the `#[tauri::command]` handlers),
//! [`apply`] (the security-critical file-write path + its tests), and [`events`]
//! (the `handle_harness_event` dispatcher).

mod apply;
mod commands;
mod events;

// Module facade: preserve the historical `crate::sidecar::harness::*` paths after the
// god-file split so call sites elsewhere keep resolving unchanged — `sidecar/mod.rs`'s
// `pub(crate) use harness::*` propagates the command fns up to `sidecar::*` for
// `generate_handler!`, and `sidecar/reader.rs` calls `super::harness::handle_harness_event`.
// Mirrors the glob-reexport pattern in `sidecar/mod.rs`.
pub use commands::*;
// `handle_harness_event` is crate-internal (`pub(crate)`), so re-export at crate visibility:
// a `pub` glob over a non-`pub` item warns "doesn't reexport anything with visibility `pub`".
pub(crate) use events::*;
// `apply` is the impl-only file-write path; its symbols are consumed within the module
// (by `commands::apply_harness_artifact` via `super::apply`), so nothing resolves through
// this re-export — it exists only to keep the facade symmetric (sidecar/mod.rs:53 convention).
#[allow(unused_imports)]
pub use apply::*;
