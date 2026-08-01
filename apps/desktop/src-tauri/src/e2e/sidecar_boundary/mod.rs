//! E2E ladder **ring 3(b)** — the CORE half of the live sidecar↔core boundary
//! (issue #253).
//!
//! ## What was already covered before this ring
//!
//! - The **shape** of the wire is guarded statically, in both directions: the zod
//!   schemas are the single source, `tools/codegen/gen-rust-contracts.ts` emits
//!   [`crate::contracts::generated`] from them, `lint:meta`'s codegen-drift rule
//!   fails on a regenerate-diff, and [`crate::contracts`]'s conformance test asserts
//!   every codegen'd fixture deserializes into the Rust type.
//! - **Ring 3** (`bun run e2e:ring3`, issue #406) boots the REAL Bun sidecar child
//!   and replays a checked-in transcript across a REAL OS pipe — but it drives that
//!   child from a TypeScript harness that constructs its commands from the same zod
//!   types the sidecar validates with. It therefore cannot observe the Rust core's
//!   serializer at all.
//! - **Ring 1(c)** replays the same fixtures through the Rust reader's seams — but
//!   from `include_str!`'d bytes, with no child and no pipe.
//!
//! ## The gap this ring closes
//!
//! Nobody ran the CORE's own encoder/decoder against a LIVE sidecar. Concretely:
//!
//! 1. **core → sidecar.** [`crate::provider::SidecarProvider`]'s `start_session`
//!    /`query` hand-map core values onto the wire (`parse_wire_enum`, the
//!    `then_some`/`Option` omissions, the serde renames). Whether the bytes that
//!    produces are ACCEPTED by the sidecar's live `SurfaceCommandSchema` /
//!    `SurfaceQuerySchema` zod validation can only be answered by a real sidecar:
//!    zod is TypeScript, so no Rust-side test and no static codegen guard can
//!    evaluate it. A rejected command is silent on stdout — the run simply never
//!    starts.
//! 2. **sidecar → core.** Whether every line a LIVE sidecar puts on the wire
//!    decodes into the core's [`crate::contracts::NightcoreEvent`] — the codegen'd
//!    fixtures prove the recorded shapes decode; this proves the shapes the running
//!    engine actually emits do (`session-started`/`session-status` are supervisor
//!    events that appear in NO fixture transcript).
//! 3. **The request/reply RPC.** `SurfaceQuery` → `query-result` correlation by
//!    `requestId` has no ring at all: ring 3 only sends `start-session`.
//!
//! ## How it stays honest
//!
//! - The child is the COMPILED sidecar (`binaries/nightcore-sidecar-<triple>`) — the
//!   artifact that actually ships. `tauri_build` hard-errors without it, so it is
//!   present whenever this crate compiles at all; there is no skip path (a skipped
//!   boundary proof is indistinguishable from a passing one).
//! - Its provider is the ladder's `ReplayAgentProvider`, selected by
//!   `NIGHTCORE_E2E_REPLAY`: no credential, no network, no spend, no model.
//! - It runs against a **scratch git repo** in a temp dir — never the nightcore
//!   checkout — with a temp `HOME`, so nothing on the developer's machine is read
//!   or written.
//! - Assertions compare **payload values** (the fixture's `numTurns`, `costUsd`,
//!   result text, failure reason), not just event shapes, so a pipeline that
//!   mangles a field reds the ring.
//! - [`contract::a_contract_violating_command_is_rejected_by_the_live_sidecar`] is
//!   the built-in anti-vacuity proof: it shows the child's validator is LIVE and
//!   rejecting, so the green in the other tests means the core's payload genuinely
//!   passed it rather than the sidecar accepting anything.

mod contract;
mod harness;
