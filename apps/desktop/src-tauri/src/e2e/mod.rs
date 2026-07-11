//! E2E ladder ring 1 (issue #150): the first `tauri::test` MockRuntime integration
//! harness over the real run engine — stores, slot manager, provider correlation,
//! circuit breaker, and boot reconciliation — driven by a **scripted fake provider**
//! (a hand-fed session↔task correlation + terminal script, never a real sidecar
//! child, never a network call). Deterministic and offline: it runs inside the
//! existing ubuntu `rust-checks` CI job (`cargo test`) with no browser and no
//! display.
//!
//! ## What this ring covers (the real subsystems, composed across a run lifecycle)
//!
//! - [`boot_state`] — a headless `MockRuntime` app managing the SAME state graph
//!   `lib.rs::run()` wires, and resolving every `State<T>` the run flow reaches
//!   (catches a "referenced-but-unmanaged state" panic — a real startup-crash class).
//! - [`run_lifecycle`] — create → lease a slot → mark in-progress → a scripted
//!   `session-started` (real FIFO correlation) → a scripted terminal → slot release,
//!   asserting the store + slot + correlation invariants stay consistent end to end.
//! - [`slot_leak`] — the past **cancel→re-run slot-leak critical** (2026-06-29 audit):
//!   a stale terminal for a superseded session must NOT release the live re-run's
//!   slot. Composes the real provider correlation + real `SlotManager` + real store.
//! - [`failure_breaker`] — the FAILURE branch of the lifecycle (`run_lifecycle`'s
//!   mirror): a run settling `Failed` + `finish_run` feeding the real `CircuitBreaker`.
//!   Asserts a failed terminal frees its slot (no leak on failure) and the breaker
//!   trips on exactly the broken-setup signals — a windowed threshold of transient
//!   failures or a single fatal one — while a clean run clears the window and an abort
//!   is spared.
//! - [`crash_requeue`] — the boot crash-recovery path: `reset_after_crash` returns
//!   the orphaned tasks + the reconcile core requeues stranded `InProgress`/`Verifying`
//!   tasks, over a real `TaskStore`.
//!
//! ## Documented gap (why this is ring 1, not the whole ladder)
//!
//! The `#[tauri::command]` handlers, the sidecar reader (`handle_event`), and the
//! orchestrator entry points are all typed on the concrete `AppHandle` (=
//! `AppHandle<Wry>`) — 300+ call sites — and `tauri::test` only offers an
//! `AppHandle<MockRuntime>`. Passing the mock handle to a Wry-typed fn is a compile
//! error (verified), and making the whole surface generic over `R: Runtime` cascades
//! through the `EngineApi`/`SessionDispatch` trait objects and every handler — a large,
//! behavior-risky refactor this ring deliberately does NOT take. So ring 1 drives the
//! run engine's **subsystems** (which are `AppHandle`-free by design — see the pure
//! cores in `orchestration::coordinator::reconcile` and `provider::correlation`)
//! composed the way a run flows, and asserts the cross-subsystem invariants where the
//! criticals actually lived. The `AppHandle`-bound glue itself (reader routing, the
//! verification verdict handlers, command emission) is covered by:
//!   - the manual UI dogfood checklist (`docs/testing/2026-07-11-manual-ui-dogfood-checklist.md`),
//!   - the `#[ignore]`-gated real-`gh` harness (`bun run dogfood:gh`, `crate::e2e_gh`),
//!   - and E2E ladder rings 2–3 (Linux `tauri-driver` golden path + fake-provider
//!     `dogfood:engine` in CI), per the v0.4 roadmap.
#![cfg(test)]

mod boot_state;
mod crash_requeue;
mod failure_breaker;
mod harness;
mod run_lifecycle;
mod slot_leak;
