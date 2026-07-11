//! The integrated USER terminal — a PTY session registry living in the Rust core
//! (a peer of `provider/` and `worktree/`), NOT the sidecar. Wezterm's
//! `portable-pty` spawns real shells; coalesced output streams over a per-session
//! binary `tauri::ipc::Channel`; scrollback is kept in a Rust-side ring and
//! persisted for read-only restore on relaunch.
//!
//! ## Hard security constraint (spec §1)
//! This seam is **USER-ONLY**. Nothing here is reachable from an agent session:
//! the registry is managed Tauri state driven exclusively by `commands/terminal.rs`
//! (webview + explicit user gesture). There is deliberately NO engine/sidecar/
//! provider wiring and NO event-system exposure — the PreToolUse confinement gate
//! and the flight recorder never see a user PTY, by design. Terminal traffic rides
//! the binary Channel, never `nc:*` events.
//!
//! ## Layout (each file a flat sibling under this manifest)
//!  - [`registry`] — the live-session map, live cap (12), spawn/write/resize/kill/
//!    list/sessions-in-dir/set-title, project-scoped scrollback persist root.
//!  - [`session`] — one PTY: `portable-pty` spawn + reader/coalescer threads +
//!    write/resize/kill.
//!  - [`shell`] — platform-aware shell resolution + interactive-launch flags (pure,
//!    injectable; the Windows and Unix chains are both testable on any host).
//!  - [`scrollback`] — the ~10k-line ring buffer + the output coalescer (both pure).
//!  - [`persist`] — the on-disk `.nightcore/terminals/<id>.json` shape (v:1) + its
//!    atomic write / read / list / age+stale-cwd prune.
//!  - [`confine`] — the opt-in macOS Seatbelt write-containment for a confined tab
//!    (fail-closed).
//!  - [`types`] — the ts-rs-exported command-return descriptors.

pub(crate) mod confine;
pub(crate) mod persist;
mod registry;
mod scrollback;
mod session;
mod shell;
mod types;

pub use registry::TerminalRegistry;
pub(crate) use session::{OutputSink, SpawnOpts};
pub use types::{PersistedTerminalInfo, PersistedTerminalScrollback, TerminalSessionInfo};
