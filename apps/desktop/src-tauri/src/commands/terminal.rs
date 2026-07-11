//! The USER terminal command surface — thin async handlers over
//! [`crate::terminal::TerminalBackend`] (managed state), which routes each op to the
//! in-process registry or, when the experimental detached daemon (PR 6) is enabled +
//! reachable, to it — degrading to in-process on any failure.
//!
//! USER-ONLY seam (spec §1): these commands are invokable only from the webview
//! behind an explicit user gesture; no agent/sidecar path reaches the backend (or the
//! daemon's owner-only socket). Output does NOT flow through here — it streams over
//! the per-session binary `tauri::ipc::Channel` passed to `terminal_spawn` /
//! `terminal_attach`. Only the small JSON descriptors (session lists, persisted
//! metadata, daemon status) return through the command layer.
//!
//! ALL async + `spawn_blocking` (a sync `#[tauri::command]` runs on the WKWebView
//! main thread and can freeze the UI — the known trap); the backend is re-acquired
//! via `app.try_state()` inside each spawned block.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::terminal::{
    OutputSink, PersistedTerminalInfo, PersistedTerminalScrollback, SpawnOpts, TerminalBackend,
    TerminalDaemonStatus, TerminalSessionInfo,
};

/// Resolve the requested spawn cwd SERVER-SIDE: canonicalize it (so a `..`/symlink
/// input resolves to a real, stable location), then require that it EXISTS and is a
/// DIRECTORY. Any user-chosen directory is a valid terminal cwd.
///
/// DELIBERATE WIDENING (folder-browser feature): this previously required the cwd
/// to be the active project's root or a dir under its `.nightcore/worktrees/` base.
/// That membership check was defense-in-depth, NOT the security boundary — the
/// terminal is the user's own unconfined seam by grilled decision 1 (never
/// agent-reachable), so restricting *which folder the human opens their own shell
/// in* bought nothing. The new-tab picker now offers a "Browse…" flow over any
/// directory, so this resolves to exists-and-is-a-directory. The real containment
/// (opt-in Seatbelt write-scoping for a CONFINED tab) is unchanged and still scopes
/// to whatever cwd resolves here, arbitrary or not.
fn resolve_spawn_cwd(cwd: &str) -> Result<PathBuf, String> {
    let candidate = std::fs::canonicalize(cwd)
        .map_err(|_| format!("cannot open a terminal — {cwd} does not exist"))?;
    if !candidate.is_dir() {
        return Err(format!("cannot open a terminal — {cwd} is not a directory"));
    }
    Ok(candidate)
}

fn backend(app: &AppHandle) -> Result<tauri::State<'_, TerminalBackend>, String> {
    app.try_state::<TerminalBackend>()
        .ok_or_else(|| "terminal backend unavailable".to_string())
}

/// Wrap a per-session binary `Channel` as an [`OutputSink`]: each coalesced batch is
/// sent as a raw ArrayBuffer (never JSON — the load-bearing transport choice, §9 trap
/// g). A closed webview makes `send` error, which we drop. Shared by `terminal_spawn`
/// and the daemon-reattach `terminal_attach` so both terminate in the SAME Raw sink.
fn channel_sink(channel: tauri::ipc::Channel) -> OutputSink {
    Box::new(move |bytes: Vec<u8>| {
        let _ = channel.send(tauri::ipc::InvokeResponseBody::Raw(bytes));
    })
}

/// Spawn a shell in `cwd` (confined when `confined` is set — macOS-only, opt-in,
/// fail-closed). Coalesced output streams over `channel` as binary `Raw` frames.
/// Returns the new session descriptor. When the detached daemon (PR 6) is enabled +
/// reachable, an UNCONFINED session is created there so it survives a restart; the
/// output still rides this same `channel` (the backend bridges the daemon's frames).
#[tauri::command]
pub async fn terminal_spawn(
    app: AppHandle,
    cwd: String,
    confined: bool,
    cols: u16,
    rows: u16,
    channel: tauri::ipc::Channel,
) -> Result<TerminalSessionInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = resolve_spawn_cwd(&cwd)?;
        backend(&app)?.spawn(
            SpawnOpts {
                cwd,
                confined,
                cols,
                rows,
            },
            channel_sink(channel),
        )
    })
    .await
    .map_err(|e| format!("terminal spawn failed to run: {e}"))?
}

/// Reattach to an EXISTING live (daemon-owned) session on relaunch (PR 6, §5.3):
/// stream its replayed buffered tail then live output onto `channel`. The web calls
/// this only for a session `terminal_list` reported live but which has no local xterm
/// instance yet (i.e. after a restart, in daemon mode). Errors when there is no such
/// live session (no daemon, or it already exited) — the caller then read-only-restores.
#[tauri::command]
pub async fn terminal_attach(
    app: AppHandle,
    id: String,
    channel: tauri::ipc::Channel,
) -> Result<TerminalSessionInfo, String> {
    tauri::async_runtime::spawn_blocking(move || backend(&app)?.attach(&id, channel_sink(channel)))
        .await
        .map_err(|e| format!("terminal attach failed to run: {e}"))?
}

/// The detached-PTY-daemon status (PR 6) — informational only (whether the
/// experimental daemon is enabled, supported on this platform, and currently live).
#[tauri::command]
pub async fn terminal_daemon_status(app: AppHandle) -> Result<TerminalDaemonStatus, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(backend(&app)?.daemon_status()))
        .await
        .map_err(|e| format!("terminal daemon_status failed to run: {e}"))?
}

/// Forward user input bytes to a session's shell.
#[tauri::command]
pub async fn terminal_write(app: AppHandle, id: String, data: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || backend(&app)?.write(&id, &data))
        .await
        .map_err(|e| format!("terminal write failed to run: {e}"))?
}

/// Set (or clear) a live session's manual tab name (decision 5). USER-only, like
/// every terminal command. An empty/whitespace title clears the name (`None`), so
/// the web falls back to the cwd leaf. The rename is persisted on the next
/// scrollback flush, so it survives a read-only restore.
#[tauri::command]
pub async fn terminal_set_title(
    app: AppHandle,
    id: String,
    title: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        backend(&app)?.set_title(&id, normalize_title(title))
    })
    .await
    .map_err(|e| format!("terminal set_title failed to run: {e}"))?
}

/// Trim a requested title and treat empty/whitespace as "clear the name" (`None`).
/// Keeps the descriptor's `title` either `None` or a non-empty string, so the web's
/// `session.title ?? cwdLeaf` fallback never renders a blank tab.
fn normalize_title(title: Option<String>) -> Option<String> {
    title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// Resize a session's pty (delivers SIGWINCH).
#[tauri::command]
pub async fn terminal_resize(
    app: AppHandle,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || backend(&app)?.resize(&id, cols, rows))
        .await
        .map_err(|e| format!("terminal resize failed to run: {e}"))?
}

/// Terminate a session (idempotent).
#[tauri::command]
pub async fn terminal_kill(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || backend(&app)?.kill(&id))
        .await
        .map_err(|e| format!("terminal kill failed to run: {e}"))?
}

/// All live sessions (dead ones reaped first).
#[tauri::command]
pub async fn terminal_list(app: AppHandle) -> Result<Vec<TerminalSessionInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(backend(&app)?.list()))
        .await
        .map_err(|e| format!("terminal list failed to run: {e}"))?
}

/// Live sessions whose cwd is `path` or under it — the cleanup-confirm seam used by
/// the worktree merge/discard dialogs (PR B).
#[tauri::command]
pub async fn terminal_sessions_in_dir(
    app: AppHandle,
    path: String,
) -> Result<Vec<TerminalSessionInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(backend(&app)?.sessions_in_dir(Path::new(&path)))
    })
    .await
    .map_err(|e| format!("terminal sessions_in_dir failed to run: {e}"))?
}

/// Persisted (dead) sessions' metadata for the restore UI (PR C). Prunes stale
/// files as a side effect.
#[tauri::command]
pub async fn terminal_list_persisted(app: AppHandle) -> Result<Vec<PersistedTerminalInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = backend(&app)?.persist_dir();
        Ok(crate::terminal::persist::list(&dir))
    })
    .await
    .map_err(|e| format!("terminal list_persisted failed to run: {e}"))?
}

/// A persisted session's scrollback bytes (base64) for read-only replay (PR C).
#[tauri::command]
pub async fn terminal_read_persisted(
    app: AppHandle,
    id: String,
) -> Result<PersistedTerminalScrollback, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = backend(&app)?.persist_dir();
        crate::terminal::persist::read(&dir, &id)
            .ok_or_else(|| format!("no persisted terminal session {id}"))
    })
    .await
    .map_err(|e| format!("terminal read_persisted failed to run: {e}"))?
}

/// Delete a persisted (dead) session's scrollback file — the restore UI's "dismiss"
/// (PR C), so a dismissed read-only tab does not reappear on the next relaunch.
/// Idempotent (a missing file is a no-op success).
#[tauri::command]
pub async fn terminal_delete_persisted(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = backend(&app)?.persist_dir();
        crate::terminal::persist::delete(&dir, &id)
    })
    .await
    .map_err(|e| format!("terminal delete_persisted failed to run: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{normalize_title, resolve_spawn_cwd};
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn normalize_title_trims_and_clears_blank_names() {
        assert_eq!(normalize_title(None), None);
        assert_eq!(normalize_title(Some("   ".to_string())), None);
        assert_eq!(normalize_title(Some(String::new())), None);
        assert_eq!(
            normalize_title(Some("  deploy shell  ".to_string())).as_deref(),
            Some("deploy shell")
        );
    }

    #[test]
    fn spawn_cwd_accepts_any_existing_directory() {
        // The deliberate widening: an arbitrary directory (NOT under any project or
        // worktree) is now a valid terminal cwd. It is canonicalized on the way out.
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("anywhere");
        fs::create_dir(&dir).unwrap();
        let resolved = resolve_spawn_cwd(dir.to_str().unwrap()).expect("an existing dir resolves");
        assert_eq!(resolved, fs::canonicalize(&dir).unwrap());
    }

    #[test]
    fn spawn_cwd_rejects_a_missing_path() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("gone");
        let err = resolve_spawn_cwd(missing.to_str().unwrap()).unwrap_err();
        assert!(err.contains("does not exist"), "got: {err}");
    }

    #[test]
    fn spawn_cwd_rejects_a_file() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("file.txt");
        fs::write(&file, "x").unwrap();
        let err = resolve_spawn_cwd(file.to_str().unwrap()).unwrap_err();
        assert!(err.contains("is not a directory"), "got: {err}");
    }
}
