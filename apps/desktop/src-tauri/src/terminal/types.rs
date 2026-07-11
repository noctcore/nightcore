//! The terminal command-return shapes (Rust→TS via ts-rs).
//!
//! Terminal OUTPUT rides the binary `ipc::Channel`, not the event system — these
//! types are only the small JSON descriptors the lifecycle commands return (session
//! lists, persisted-scrollback metadata + replay bytes). They serialize camelCase
//! for the bridge; ts-rs exports the twins under `cargo test` like every other
//! command-return shape (`bindings/export.rs`).

use serde::{Deserialize, Serialize};
#[cfg(test)]
use ts_rs::TS;

use super::title::TitleSource;

/// One live PTY session as the webview sees it. Returned by `terminal_spawn`,
/// `terminal_list`, and `terminal_sessions_in_dir`. `alive` is `false` only in the
/// brief window between a shell exiting and the registry reaping it.
///
/// `Deserialize` is derived (in addition to the wire `Serialize`) so the detached
/// PTY daemon's IPC client (cockpit spec PR 6) can decode the session descriptors
/// the daemon sends back over its local socket — it is the same camelCase shape,
/// round-tripped, never a second schema.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "TerminalSessionInfo.ts"))]
pub struct TerminalSessionInfo {
    /// Server-minted session id (a uuid) — the handle for write/resize/kill and the
    /// persisted-scrollback filename.
    pub id: String,
    /// The absolute working directory the shell was spawned in.
    pub cwd: String,
    /// The shell program launched — resolved platform-aware (`$SHELL`, else the
    /// Unix zsh/bash/sh or Windows pwsh/powershell/cmd fallback chain).
    pub shell: String,
    /// Whether this session runs inside the opt-in Seatbelt write-containment
    /// profile (macOS only). Drives the identity chrome (PR B).
    pub confined: bool,
    pub cols: u16,
    pub rows: u16,
    /// `false` once the underlying process has exited.
    pub alive: bool,
    /// Epoch-ms the session was spawned.
    pub created_at: u64,
    /// The tab's name (manual / task / AI, decision 5 + round-2 PR A), or `None` when
    /// unnamed — the web then falls back to the cwd leaf. Set via `terminal_set_title`
    /// and persisted so it survives a read-only restore.
    pub title: Option<String>,
    /// Where `title` came from — the precedence source (round-2 PR A): `Manual` /
    /// `Task` always out-rank an AI (`Auto`) name. `None` for a never-titled session
    /// OR a legacy record written before this field existed (a non-empty legacy title
    /// is treated as Manual-equivalent, so the AI never clobbers it). Serde-additive.
    #[serde(default)]
    pub title_source: Option<TitleSource>,
}

/// Metadata for a persisted (dead) session's scrollback, without the bytes —
/// returned by `terminal_list_persisted` so the restore UI (PR C) can list
/// resumable tabs cheaply.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PersistedTerminalInfo.ts"))]
pub struct PersistedTerminalInfo {
    pub id: String,
    pub cwd: String,
    pub shell: String,
    pub confined: bool,
    pub created_at: u64,
    /// Epoch-ms of the last scrollback flush to disk.
    pub updated_at: u64,
    /// The session's name (decision 5), or `None` when it was never renamed — so a
    /// restored (read-only) tab shows the same name it had while live, and old
    /// persisted files (no `title`) restore to the cwd leaf.
    pub title: Option<String>,
    /// The persisted title's precedence source (round-2 PR A), or `None` for a
    /// never-titled / legacy record. Carried through restore so a restored tab keeps
    /// its Manual/Task/AI provenance. Serde-additive.
    #[serde(default)]
    pub title_source: Option<TitleSource>,
}

/// Detached-PTY-daemon status (cockpit spec PR 6) — returned by
/// `terminal_daemon_status` so the Settings toggle + dogfood can show whether the
/// experimental daemon is actually running. Never gates behavior; purely
/// informational (the backend degrades on its own regardless of what this reports).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "TerminalDaemonStatus.ts"))]
pub struct TerminalDaemonStatus {
    /// The `terminal_daemon_enabled` setting (the user's opt-in).
    pub enabled: bool,
    /// Whether this platform can run the daemon at all (macOS/Linux only in v1). When
    /// `false`, the toggle is a no-op and the terminal read-only-restores like today.
    pub supported: bool,
    /// Whether a daemon connection is currently live (enabled + supported + a session
    /// has caused a connect). `false` with `enabled` + `supported` just means no
    /// daemon-eligible session has connected yet this launch.
    pub active: bool,
}

/// A persisted session's metadata plus its scrollback bytes (base64) for read-only
/// replay on relaunch — returned by `terminal_read_persisted` (PR C). Base64 keeps
/// the raw terminal stream (escape sequences and all) intact across the JSON
/// command boundary; the bytes are fed verbatim to `term.write()`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PersistedTerminalScrollback.ts"))]
pub struct PersistedTerminalScrollback {
    pub info: PersistedTerminalInfo,
    /// The scrollback stream, base64-encoded.
    pub data_base64: String,
}
