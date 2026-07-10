//! The terminal command-return shapes (Rust→TS via ts-rs).
//!
//! Terminal OUTPUT rides the binary `ipc::Channel`, not the event system — these
//! types are only the small JSON descriptors the lifecycle commands return (session
//! lists, persisted-scrollback metadata + replay bytes). They serialize camelCase
//! for the bridge; ts-rs exports the twins under `cargo test` like every other
//! command-return shape (`bindings/export.rs`).

use serde::Serialize;
#[cfg(test)]
use ts_rs::TS;

/// One live PTY session as the webview sees it. Returned by `terminal_spawn`,
/// `terminal_list`, and `terminal_sessions_in_dir`. `alive` is `false` only in the
/// brief window between a shell exiting and the registry reaping it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "TerminalSessionInfo.ts"))]
pub struct TerminalSessionInfo {
    /// Server-minted session id (a uuid) — the handle for write/resize/kill and the
    /// persisted-scrollback filename.
    pub id: String,
    /// The absolute working directory the shell was spawned in.
    pub cwd: String,
    /// The shell program launched (`$SHELL` or the `/bin/zsh` fallback).
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
