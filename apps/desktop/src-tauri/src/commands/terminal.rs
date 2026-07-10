//! The USER terminal command surface — thin async handlers over
//! [`crate::terminal::TerminalRegistry`] (managed state).
//!
//! USER-ONLY seam (spec §1): these commands are invokable only from the webview
//! behind an explicit user gesture; no agent/sidecar path reaches the registry.
//! Output does NOT flow through here — it streams over the per-session binary
//! `tauri::ipc::Channel` passed to `terminal_spawn`. Only the small JSON
//! descriptors (session lists, persisted metadata) return through the command
//! layer.
//!
//! ALL async + `spawn_blocking` (a sync `#[tauri::command]` runs on the WKWebView
//! main thread and can freeze the UI — the known trap); the registry is re-acquired
//! via `app.try_state()` inside each spawned block.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::project::ProjectStore;
use crate::terminal::{
    OutputSink, PersistedTerminalInfo, PersistedTerminalScrollback, SpawnOpts, TerminalRegistry,
    TerminalSessionInfo,
};

/// Resolve + confine the requested spawn cwd SERVER-SIDE: it must be the active
/// project's root or a dir under its `.nightcore/worktrees/` base (exactly what the
/// new-tab picker offers). Paths are canonicalized so a `..`/symlink cwd can't open
/// a shell outside the project — the same posture as `reveal_worktree`, since here
/// the cwd arrives raw from the webview.
fn resolve_spawn_cwd(app: &AppHandle, cwd: &str) -> Result<PathBuf, String> {
    let project = app
        .try_state::<ProjectStore>()
        .and_then(|s| s.active())
        .ok_or_else(|| "no active project — open a project before a terminal".to_string())?;
    let project_root = std::fs::canonicalize(&project.path)
        .map_err(|_| "the active project's path no longer exists".to_string())?;
    let candidate = std::fs::canonicalize(cwd)
        .map_err(|_| format!("cannot open a terminal — {cwd} does not exist"))?;
    if !candidate.is_dir() {
        return Err(format!("cannot open a terminal — {cwd} is not a directory"));
    }
    let worktrees_base = crate::worktree::worktrees_base(&project_root);
    let allowed =
        candidate == project_root || crate::worktree::is_under(&worktrees_base, &candidate);
    if !allowed {
        return Err(
            "refusing to open a terminal outside the project root or its worktrees".to_string(),
        );
    }
    Ok(candidate)
}

fn registry(app: &AppHandle) -> Result<tauri::State<'_, TerminalRegistry>, String> {
    app.try_state::<TerminalRegistry>()
        .ok_or_else(|| "terminal registry unavailable".to_string())
}

/// Spawn a shell in `cwd` (confined when `confined` is set — macOS-only, opt-in,
/// fail-closed). Coalesced output streams over `channel` as binary `Raw` frames.
/// Returns the new session descriptor.
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
        let cwd = resolve_spawn_cwd(&app, &cwd)?;
        // Wrap the binary Channel as the session's output sink: each coalesced batch
        // is sent as a raw ArrayBuffer (never JSON — the load-bearing transport
        // choice). A closed webview makes `send` error, which we drop.
        let sink: OutputSink = Box::new(move |bytes: Vec<u8>| {
            let _ = channel.send(tauri::ipc::InvokeResponseBody::Raw(bytes));
        });
        registry(&app)?.spawn(
            SpawnOpts {
                cwd,
                confined,
                cols,
                rows,
            },
            sink,
        )
    })
    .await
    .map_err(|e| format!("terminal spawn failed to run: {e}"))?
}

/// Forward user input bytes to a session's shell.
#[tauri::command]
pub async fn terminal_write(app: AppHandle, id: String, data: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || registry(&app)?.write(&id, &data))
        .await
        .map_err(|e| format!("terminal write failed to run: {e}"))?
}

/// Resize a session's pty (delivers SIGWINCH).
#[tauri::command]
pub async fn terminal_resize(
    app: AppHandle,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || registry(&app)?.resize(&id, cols, rows))
        .await
        .map_err(|e| format!("terminal resize failed to run: {e}"))?
}

/// Terminate a session (idempotent).
#[tauri::command]
pub async fn terminal_kill(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || registry(&app)?.kill(&id))
        .await
        .map_err(|e| format!("terminal kill failed to run: {e}"))?
}

/// All live sessions (dead ones reaped first).
#[tauri::command]
pub async fn terminal_list(app: AppHandle) -> Result<Vec<TerminalSessionInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(registry(&app)?.list()))
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
        Ok(registry(&app)?.sessions_in_dir(Path::new(&path)))
    })
    .await
    .map_err(|e| format!("terminal sessions_in_dir failed to run: {e}"))?
}

/// Persisted (dead) sessions' metadata for the restore UI (PR C). Prunes stale
/// files as a side effect.
#[tauri::command]
pub async fn terminal_list_persisted(app: AppHandle) -> Result<Vec<PersistedTerminalInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = registry(&app)?.persist_dir();
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
        let dir = registry(&app)?.persist_dir();
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
        let dir = registry(&app)?.persist_dir();
        crate::terminal::persist::delete(&dir, &id)
    })
    .await
    .map_err(|e| format!("terminal delete_persisted failed to run: {e}"))?
}
