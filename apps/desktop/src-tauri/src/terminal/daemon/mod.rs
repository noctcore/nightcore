//! The detached PTY daemon (cockpit spec PR 6, §5) — live-PTY survival across app
//! restarts. **Experimental, opt-in (`terminal_daemon_enabled`, default off), and
//! macOS/Linux-only** (§5.6); every failure path degrades to the shipped in-process
//! PTY + read-only restore, so today's behavior is always the fallback.
//!
//! ## USER-ONLY seam (re-asserted, §5.7)
//! The daemon widens the terminal seam with a NEW local socket, so the hard rule is
//! re-stated here: the socket is **owner-only** (`0700` dir / `0600` socket), **local
//! only** (no TCP, ever), and speaks ONLY to the app's command layer — never to any
//! engine / sidecar / provider path. No agent session can reach it. The daemon is a
//! child of a detached launcher, not the window, and holds only a bounded replay ring
//! (not full history); the on-disk scrollback stays owner-only + export-excluded.
//!
//! ## Layout
//!  - [`protocol`] — the length-prefixed control-JSON + binary-output wire format +
//!    version negotiation (pure; unit-tested).
//!  - [`discovery`] — capability check, owner-only socket path, and the detached
//!    (`setsid`) re-invoke of this exe as the daemon.
//!  - [`fanout`] — per-session output multiplexer: sequence-numbered replay ring +
//!    live subscriber.
//!  - [`server`] — the daemon process: accept loop, session ownership, idle self-exit.
//!  - [`client`] — the app-side IPC client the terminal backend proxies through.

mod discovery;
mod launch;

pub(crate) use discovery::daemon_supported;
pub use launch::maybe_run_daemon;

// The socket/transport internals are Unix-only (§5.6). On Windows the terminal
// backend never constructs a client — `daemon_supported()` is `false` — so none of
// this compiles there, keeping the fallback truly identical to today.
#[cfg(unix)]
mod client;
#[cfg(unix)]
mod fanout;
#[cfg(all(unix, test))]
mod integration_tests;
#[cfg(unix)]
mod protocol;
#[cfg(unix)]
mod server;

#[cfg(unix)]
pub(crate) use client::DaemonClient;
#[cfg(unix)]
pub(crate) use discovery::{socket_path, spawn_detached, DEFAULT_IDLE_GRACE_SECS};
