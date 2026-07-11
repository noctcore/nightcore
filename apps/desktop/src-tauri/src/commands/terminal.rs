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
    auto_eligible, OutputSink, PersistedTerminalInfo, PersistedTerminalScrollback, SpawnOpts,
    TerminalBackend, TerminalDaemonStatus, TerminalSessionInfo, TitleSource,
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

/// Set (or clear) a live session's tab name with its precedence `source` (decision 5
/// + round-2 PR A). USER-only, like every terminal command. An empty/whitespace title
/// clears the name (`None`), so the web falls back to the cwd leaf. The guarded write
/// lands only if `source` out-ranks-or-ties the current source (Manual/Task always
/// beat an AI name). A missing `source` (an older webview) is treated as `Manual`,
/// matching the pre-feature behavior. Persisted on the next scrollback flush, so it
/// survives a read-only restore.
#[tauri::command]
pub async fn terminal_set_title(
    app: AppHandle,
    id: String,
    title: Option<String>,
    source: Option<TitleSource>,
) -> Result<(), String> {
    let source = source.unwrap_or(TitleSource::Manual);
    tauri::async_runtime::spawn_blocking(move || {
        backend(&app)?.set_title(&id, normalize_title(title), source)
    })
    .await
    .map_err(|e| format!("terminal set_title failed to run: {e}"))?
}

/// Apply the shell's own process-title (OSC 0/2) to a session's tab (T11) with the
/// LOWEST `ProcessTitle` precedence, GUARDED under the registry lock — so a Manual /
/// Task / AI name always wins and the process-title only fills an Unset session (or
/// replaces a prior process-title). A blank title is a no-op. Returns the title it
/// ACTUALLY applied (`Some`), or `None` when it was refused (a higher-ranked name is
/// set) or was blank — so the web reflects only a name that stuck, exactly like
/// `terminal_suggest_title`. USER-only + async + `spawn_blocking` like every terminal
/// command; the web debounces the noisy `onTitleChange` stream before calling this.
#[tauri::command]
pub async fn terminal_set_process_title(
    app: AppHandle,
    id: String,
    title: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(title) = normalize_title(Some(title)) else {
            return Ok(None);
        };
        let be = backend(&app)?;
        be.set_title(&id, Some(title), TitleSource::ProcessTitle)?;
        // Read the AUTHORITATIVE post-write state: return the title only if the
        // ProcessTitle write actually landed (source is still ProcessTitle). A
        // higher-ranked name that raced in / is already set yields None, so the web
        // never reflects a process-title that didn't stick.
        let applied = be
            .list()
            .into_iter()
            .find(|s| s.id == id)
            .filter(|s| s.title_source == Some(TitleSource::ProcessTitle))
            .and_then(|s| s.title);
        Ok(applied)
    })
    .await
    .map_err(|e| format!("terminal set_process_title failed to run: {e}"))?
}

/// The AI tab-naming instruction (round-2 PR A): a tiny, deterministic prompt. The
/// last command rides the one-shot's stdin; every tool is disallowed (the seam's
/// least-privilege), so this can never read or exfiltrate anything beyond that input.
const SUGGEST_INSTRUCTION: &str = "Give a 2-3 word, lowercase title for a terminal tab \
    running the command on stdin. Reply with ONLY the title, no punctuation.";

/// Suggest an AI tab title from the last command (round-2 PR A, opt-in). Wraps the
/// shared `claude -p` haiku one-shot ([`crate::workflow::oneshot::run_oneshot`] —
/// `--model haiku`, ALL tools disallowed, 30s bound, best-effort → `None`), sanitizes
/// the reply to a 2–3-word title, and applies it with `Auto` precedence GUARDED under
/// the registry lock — so a Manual/Task rename that landed during the ~2s generation
/// still wins. Returns the applied title, or `None` when naming is off, the session
/// isn't AI-eligible, generation failed/was garbled, or a higher-ranked rename raced
/// in. Fail-soft by construction: any miss keeps the current title and never errors
/// the UI. USER-only + async + `spawn_blocking` like every terminal command.
#[tauri::command]
pub async fn terminal_suggest_title(
    app: AppHandle,
    id: String,
    command: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Guard OFF (settings), read live so toggling takes effect without a relaunch.
        if !ai_naming_enabled(&app) {
            return Ok(None);
        }
        let be = backend(&app)?;
        // Server-side eligibility pre-check (defense in depth): never spend a `claude`
        // spawn on a Manual/Task-locked (or legacy-titled) session.
        let eligible = be
            .list()
            .into_iter()
            .find(|s| s.id == id)
            .is_some_and(|s| auto_eligible(s.title.as_deref(), s.title_source));
        if !eligible {
            return Ok(None);
        }
        // Generate (a blocking child spawn) — best-effort → None. `cap` bounds the
        // stdin payload; `strip_code_fence` + `sanitize_title` clean the reply.
        let raw = crate::workflow::oneshot::run_oneshot(
            SUGGEST_INSTRUCTION,
            crate::workflow::oneshot::cap(&command, 4000),
        );
        let Some(title) = raw
            .as_deref()
            .map(crate::workflow::oneshot::strip_code_fence)
            .and_then(sanitize_title)
        else {
            return Ok(None);
        };
        // Apply with Auto precedence, guarded under the registry lock, then read the
        // AUTHORITATIVE post-write state: return the title only if the Auto write
        // actually landed (source is still Auto). A Manual/Task rename that raced in
        // wins and yields `None` here, so the web never reflects a name that didn't
        // stick.
        be.set_title(&id, Some(title), TitleSource::Auto)?;
        let applied = be
            .list()
            .into_iter()
            .find(|s| s.id == id)
            .filter(|s| s.title_source == Some(TitleSource::Auto))
            .and_then(|s| s.title);
        Ok(applied)
    })
    .await
    .map_err(|e| format!("terminal suggest_title failed to run: {e}"))?
}

/// Whether the opt-in AI tab-naming setting (`terminal_ai_naming`) is on — read live
/// from the settings store so a toggle takes effect without a relaunch. Missing store
/// (never in production) fails closed to `false`.
fn ai_naming_enabled(app: &AppHandle) -> bool {
    app.try_state::<crate::settings::SettingsStore>()
        .map(|store| store.with_settings(|s| s.terminal_ai_naming))
        .unwrap_or(false)
}

/// Fire a desktop notification that a command finished in a terminal tab (T11). The
/// WEB decides WHEN to call this — only for a shell completion signal (OSC 9/99/777 or
/// a BEL) that fired while the terminal view was NOT focused/visible (it owns the
/// focus/visibility knowledge the Rust side lacks) and only when the
/// `terminal_bell_notify` setting is on. USER-only + async like every terminal command.
/// Best-effort: a failed notification is logged at debug, never surfaced. Body carries
/// only the tab label — never any shell output (the OSC/BEL payload is consumed by the
/// web parser and never reaches here), preserving the M4.5 logging discipline.
#[tauri::command]
pub async fn terminal_notify_complete(app: AppHandle, tab_title: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_notification::NotificationExt;
        let label = tab_title.trim();
        let body = if label.is_empty() {
            "A terminal command finished".to_string()
        } else {
            format!("Command finished in {label}")
        };
        if let Err(e) = app
            .notification()
            .builder()
            .title("Terminal")
            .body(body)
            .show()
        {
            tracing::debug!(target: "nightcore", error = %e, "terminal completion notification failed");
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("terminal notify_complete failed to run: {e}"))?
}

/// Sanitize a raw one-shot reply into a tab title (round-2 PR A): trim, reject empty
/// or multi-line (garbled) output, strip trailing sentence punctuation, and clamp to
/// ~24 chars / 3 words. `None` ⇒ keep the current title (fail-soft), never a blank or
/// multi-line tab. `pub(crate)` only for the unit test alongside `normalize_title`.
fn sanitize_title(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    // A clean tab title is one short line — reject empty or multi-line replies.
    if trimmed.is_empty() || trimmed.contains('\n') {
        return None;
    }
    let stripped = trimmed
        .trim_end_matches(['.', '!', '?', ',', ';', ':'])
        .trim();
    let joined = stripped
        .split_whitespace()
        .take(3)
        .collect::<Vec<_>>()
        .join(" ");
    let capped = crate::workflow::oneshot::cap(&joined, 24)
        .trim()
        .to_string();
    (!capped.is_empty()).then_some(capped)
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
    use super::{normalize_title, resolve_spawn_cwd, sanitize_title};
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn sanitize_title_clamps_words_and_strips_punctuation() {
        assert_eq!(
            sanitize_title("build web app now here").as_deref(),
            Some("build web app"),
            "clamps to the first 3 words"
        );
        assert_eq!(
            sanitize_title("  deploy shell.  ").as_deref(),
            Some("deploy shell"),
            "trims + strips a trailing period"
        );
        assert_eq!(sanitize_title("run tests!").as_deref(), Some("run tests"));
    }

    #[test]
    fn sanitize_title_rejects_empty_and_garbled_output() {
        // Fail-soft: empty / whitespace / multi-line replies keep the current title.
        assert_eq!(sanitize_title(""), None);
        assert_eq!(sanitize_title("   "), None);
        assert_eq!(
            sanitize_title("here is a title:\nbuild web"),
            None,
            "a multi-line (chatty) reply is rejected, not partially used"
        );
        assert_eq!(sanitize_title("."), None, "punctuation-only ⇒ None");
    }

    #[test]
    fn sanitize_title_caps_length_on_a_char_boundary() {
        // A single over-long word (multi-byte glyphs) is clamped to ≤24 bytes without
        // splitting a glyph — proving the cap rides `oneshot::cap`'s boundary logic.
        let capped = sanitize_title(&"é".repeat(30)).expect("some title");
        assert!(
            capped.len() <= 24 && capped.chars().all(|c| c == 'é'),
            "capped to ~24 bytes on a boundary, got {capped:?}"
        );
    }

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
