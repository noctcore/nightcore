//! The provider seam (M2 §7 of the design doc) — SCAFFOLD, no implementation.
//!
//! The seam between the Rust core and an agent backend is the **sidecar process
//! boundary**: each provider is a separate sidecar speaking the one NDJSON
//! `SurfaceCommand`/`NightcoreEvent` protocol. This trait is the Rust-side
//! abstraction. M2 ships exactly one implementation (`SidecarProvider`, wrapping
//! today's `sidecar.rs` child); a Codex/other provider later is an additive
//! sidecar binary + factory arm, never a `match provider` branch in the core.
//!
//! Scaffold note: the methods are shown synchronous here to keep the seam
//! dependency-free and compiling. When wired in M2 they become `async` (driving
//! `tokio` child stdio, exactly like `sidecar.rs`); the design doc lists the
//! intended async signatures. Nothing here is implemented or registered — it
//! exists to pin the boundary for review.

use std::path::PathBuf;

/// A driveable agent backend. Today: the Bun Claude sidecar. Later: a Codex
/// sidecar speaking the same protocol — selected by config, not by branching in
/// the core. The core only ever consumes the normalized `NightcoreEvent` stream;
/// it never sees a provider-native message.
pub trait Provider: Send + Sync {
    /// Ensure the backend is running, spawning it lazily. Idempotent.
    fn ensure_started(&self) -> Result<(), String>;

    /// Start one run; returns the session id used to correlate its events back to
    /// the task that owns the run.
    fn start_session(
        &self,
        prompt: String,
        model: Option<String>,
        cwd: Option<PathBuf>,
    ) -> Result<u64, String>;

    /// Best-effort interrupt of a run by session id.
    fn interrupt(&self, session_id: u64) -> Result<(), String>;

    /// Decide a pending permission request for a run (M2 default: deny).
    fn decide_permission(
        &self,
        session_id: u64,
        request_id: &str,
        allow: bool,
    ) -> Result<(), String>;
}
