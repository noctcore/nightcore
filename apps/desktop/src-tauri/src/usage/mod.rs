//! The provider usage meter (issue #121) — a read-only telemetry system that reads
//! the OAuth credentials the user's `claude` / `codex` CLIs already wrote, calls
//! each provider's usage endpoint on a 10-minute timer, and renders the returned
//! rate-limit windows in the sidebar footer (the web widget lands in PR B).
//!
//! A top-level module (a peer of `provider/`, `terminal/`, `worktree.rs`) because it
//! owns SYSTEM seams — the macOS Keychain, the HTTP client, and `~/.claude` /
//! `~/.codex` file reads — so it can't live in a `store/` leaf (pure persistence) or
//! in the per-run sidecar (no system-credential ownership). It must run regardless
//! of sidecar state.
//!
//! ## Hard constraints (spec §1)
//!  - **Read-only, never a token manager:** never writes/refreshes/rotates a
//!    credential. On 401 it surfaces re-auth guidance and stops (spec decision 4).
//!  - **Tokens live only as long as the request:** read at poll time, moved into the
//!    request, dropped when it returns — never stored in state, a log, or the
//!    emitted snapshot (spec §3.7).
//!  - **Fail-soft everywhere:** every failure degrades ONE provider row via the
//!    [`UsageStatus`](contract::UsageStatus) machine — never a panic, never a blank
//!    widget (spec §3.6).
//!  - **Opt-in:** the poll loop parks until the `usage_meter_enabled` flag is set,
//!    spending zero CPU/network before the user opts in (spec decision 5).
//!
//! ## Layout (flat siblings under this manifest, house pattern)
//!  - [`contract`] — the ts-rs wire types (registered in `bindings/export.rs`).
//!  - `registry` — the managed-state [`UsageRegistry`] (last-good snapshot +
//!    cooldowns + cost cache + poll-loop primitives).
//!  - `poller` — the 10-minute single-flight loop + the `nc:usage` push.
//!  - `credentials` — Keychain + file credential reads.
//!  - `claude` / `codex` — per-provider fetch + defensive parsers.
//!  - `http` — the one rustls `reqwest` client + the fail-soft taxonomy + redaction.
//!  - `cost` / `pricing` — the popover-only local JSONL cost ESTIMATE.

pub(crate) mod contract;

mod claude;
mod codex;
mod cost;
mod credentials;
mod http;
mod poller;
mod pricing;
mod registry;
mod throttle;

pub(crate) use credentials::prime_credentials;
pub(crate) use poller::{arm, kick, REFRESH_MIN_AGE};
pub use registry::UsageRegistry;
// Usage-aware auto-mode throttle (spec 2026-07-11): the provider-scoped decision the
// coordinator's tick gate consumes. Lives here (not `orchestration/`) so the gate
// stays provider-id-agnostic (issue #18 arch invariant).
pub(crate) use throttle::{hot_window, provider_display, UsagePause};
// `USAGE_EVENT` — the single `nc:usage` channel const, authored once in `poller`.
// Re-exported for `commands::usage` (issue #305: the enable/disable commands push a
// state-change snapshot on this SAME channel so every listening surface, not just
// the poller's own 10-min tick, reconciles live) and for the `contracts::mod`
// channel-conformance test.
pub(crate) use poller::USAGE_EVENT;
