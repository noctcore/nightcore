//! The persistent provider sidecar reader and the run/cancel commands.
//!
//! Protocol (line-delimited JSON over the child's stdio):
//!   - we WRITE one `SurfaceCommand` JSON object per line to the sidecar's stdin
//!   - we READ one `NightcoreEvent` JSON object per line from its stdout
//!   - the sidecar's stderr is human logs; we CAPTURE it (provider.rs pipes it)
//!     and re-emit each line through the Rust `tracing` sink under target `sidecar`
//!
//! M2 generalizes M1's single-task serial path to N concurrent sessions through
//! ONE persistent sidecar (the engine's `SessionManager` already multiplexes
//! sessions). The change from M1: the reader correlates each event to a task via
//! the provider's `sessionId → taskId` map (M1 tagged everything with the single
//! `active_task`). Concurrency is bounded by the [`SlotManager`]; a run holds a
//! slot from lease until its terminal event releases it.
//!
//! `run_task` stays as the manual single-run path (useful even with the loop):
//! it leases a slot, allocates a worktree, and dispatches — exactly what the
//! coordinator's `launch` does, just triggered by a click instead of a tick.

mod capabilities;
mod channels;
mod commands;
mod convert;
// The Council write-capable worktree seam (issue #383): the host handler + run registry for
// the path-less `worktree-op-required` → `resolve-worktree-op` RPC. `pub(crate)` so `lib.rs`
// can `manage` the registry and `commands.rs` can register/forget runs.
pub(crate) mod council_worktree;
mod harness;
mod insight;
mod issue_map;
mod issue_sync;
mod issue_triage;
mod lifecycle;
mod models;
mod permission;
mod pr_review;
mod provider_config;
mod reader;
mod rule_tester;
// `pub(crate)` so the crate-root `e2e` transcript-replay suite (issue #278) can drive
// the scan finalizer seam (`finalize_scan_items` / `reconcile_scan_history` /
// `ScanTelemetry`) — the exact `AppHandle`-free functions `handle_analysis_event` /
// `handle_pr_review_event` delegate persistence to. Its contents are already
// `pub(crate)`; only the module path was `sidecar`-private. No behavior change.
pub(crate) mod scan;
mod scorecard;
mod seam;
mod sessions;
mod transport;
mod verification;

// Module facade: preserve the historical `crate::sidecar::*` paths after the
// god-file split so call sites elsewhere keep resolving unchanged. The command
// re-export is a glob so the `#[tauri::command]` macro's generated siblings
// (`__cmd__*`, `__tauri_command_name_*`) reach `sidecar::*` for `generate_handler!`.
pub(crate) use commands::*;
// The session-history/resume commands (glob so the macro siblings resolve through
// `sidecar::*` for `generate_handler!`, like `commands::*`).
pub(crate) use sessions::*;
// The read-only provider-config inspector command (glob so the `#[tauri::command]`
// macro siblings resolve through `sidecar::*` for `generate_handler!`).
pub(crate) use provider_config::*;
// The dynamic model-catalog command `list_models` (issue #80; glob so the
// `#[tauri::command]` macro siblings resolve through `sidecar::*` for `generate_handler!`).
pub(crate) use models::*;
// The provider-capability command `get_capabilities` (issue #18, B5; glob so the
// `#[tauri::command]` macro siblings resolve through `sidecar::*` for `generate_handler!`).
pub(crate) use capabilities::*;
// The one-shot RuleTester validation command `validate_plugin_rule` (issue #185; glob
// so the `#[tauri::command]` macro siblings resolve through `sidecar::*` for `generate_handler!`).
pub(crate) use rule_tester::*;
// The Insight (codebase analysis) commands + the reader-side `analysis-*` handler
// (glob so the `#[tauri::command]` macro siblings resolve through `sidecar::*`).
pub(crate) use insight::*;
// The Harness (codebase convention auditor) commands + the reader-side `harness-*`
// handler (glob so the `#[tauri::command]` macro siblings resolve through `sidecar::*`).
pub(crate) use harness::*;
// The Readiness Scorecard (Profile) commands + the reader-side `scorecard-*` handler
// (glob so the `#[tauri::command]` macro siblings resolve through `sidecar::*`).
pub(crate) use scorecard::*;
// The PR Review commands + the reader-side `pr-review-*` handler (glob so the
// `#[tauri::command]` macro siblings resolve through `sidecar::*` for `generate_handler!`).
pub(crate) use pr_review::*;
// The Issue Triage commands + the reader-side `issue-validation-*` handler (glob so the
// `#[tauri::command]` macro siblings resolve through `sidecar::*` for `generate_handler!`).
pub(crate) use issue_triage::*;
// The issue-map export commands (glob so the `#[tauri::command]` macro siblings resolve
// through `sidecar::*` for `generate_handler!`).
pub(crate) use issue_map::*;
// The GitHub two-way sync writeback command `sync_issue_status` (#97; glob so the
// `#[tauri::command]` macro siblings resolve through `sidecar::*` for `generate_handler!`).
pub(crate) use issue_sync::*;
// The workflow-facing session dispatchers are no longer re-exported here: the
// workflow tier reaches them through the managed `Arc<dyn SessionDispatch>` seam
// (`seam::SidecarSessions` — issue #33), never as `crate::sidecar::*`.
pub(crate) use seam::SidecarSessions;
// Re-exported only to keep the `crate::sidecar::MAX_FIX_ATTEMPTS` intra-doc link
// in `task.rs` resolving; no code outside `verification` reads it through here.
#[allow(unused_imports)]
pub(crate) use verification::MAX_FIX_ATTEMPTS;
// The NDJSON transport (spawn/readers/query/crash recovery) and the run-lifecycle
// terminal bookkeeping (finish/park/notify/apply), split out for issue #37; the
// globs preserve the historical `crate::sidecar::*` paths.
pub(crate) use lifecycle::*;
pub(crate) use transport::*;
// The Tauri event channel-name constants (`nc:session`, `nc:permission`, …),
// split out for issue #17 D; the glob preserves the historical `crate::sidecar::*`
// paths.
pub(crate) use channels::*;
// The Council run registry (issue #383): the host-trusted `councilRunId → project root`
// binding the worktree-op handler consults. Managed in `lib.rs`, written by `commands.rs`.
pub(crate) use council_worktree::CouncilRunRegistry;
