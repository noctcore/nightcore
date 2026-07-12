//! E2E ring 1 (c) — transcript-replay regression fixtures (issue #278).
//!
//! The scripted-fake-provider suite (`e2e::run_lifecycle` / `slot_leak` / …) drives the
//! run engine's state machine with hand-fed calls. This module adds the missing #150
//! deliverable: replay CHECKED-IN transcripts of the shapes a REAL sidecar emits —
//! grounded line-for-line in the codegen'd `contracts/fixtures.json` (see
//! `fixtures/README.md`) — through the reader's correlation + finalizer seams, and
//! assert the resulting store state + the emitted-event sequence. Deterministic and
//! offline: no live sidecar, no model, no network, so it runs in the existing ubuntu
//! `cargo test` job at no new CI cost.
//!
//! ## Why a driver that MIRRORS the reader instead of calling it
//!
//! `sidecar::reader::handle_event` (and the scan-family `handle_*_event`s) are typed on
//! `AppHandle<Wry>`, and `tauri::test` only offers an `AppHandle<MockRuntime>` — the
//! documented ring-1 gap (`e2e`'s module doc). So each driver here feeds transcript
//! events through a faithful mirror of the reader's routing that delegates EVERY state
//! mutation to the reader's own `AppHandle`-free helpers:
//!
//!   - **build** (`sessionId`-correlated): the real `SidecarProvider::correlate` FIFO,
//!     `TaskStore`, `SlotManager`, and `CircuitBreaker` — the reader's session arm.
//!   - **scan / pr-review** (`runId`-correlated): the real `StoredFinding::from_wire` /
//!     `StoredReviewFinding::from_wire`, `ScanTelemetry::from_event`,
//!     `accumulate_findings`, `reconcile_scan_history`, and `finalize_scan_items` — the
//!     exact functions `handle_analysis_event` / `handle_pr_review_event` call, in the
//!     same order. Only the `app.emit` forward (a pure `AppHandle<Wry>`-bound
//!     passthrough) is modelled as a recorded log entry rather than a real Tauri emit.
//!
//! What stays out of scope (the heavier #253 variant): booting the real Bun sidecar +
//! a live model against a scratch repo and asserting the event/command contract over a
//! real process boundary. That is the `dogfood:engine` / `dogfood:gh` harnesses' job;
//! this ring exercises real provider OUTPUT SHAPES against the reader deterministically.

mod build;
mod pr_review;
mod replay;
mod scan;
