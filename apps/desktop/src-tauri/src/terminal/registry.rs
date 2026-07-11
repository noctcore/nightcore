//! The terminal session registry — the managed-state home for all live PTY
//! sessions (global, AutoMaker-style tabs — decision 4), keyed by server-minted
//! session id.
//!
//! USER-ONLY seam (spec §1 hard constraint): this registry is reached ONLY from
//! the Tauri command layer (`commands/terminal.rs`), which is invokable only from
//! the webview behind an explicit user gesture. No engine/sidecar/provider path
//! constructs or drives it — a PTY is never agent-reachable.
//!
//! `persist_root` is the active project's `.nightcore/terminals/` (retargeted on
//! project switch, mirroring the task/scan stores). Dead sessions are reaped
//! lazily on `spawn`/`list`/`sessions_in_dir`, so the live-session cap counts only
//! sessions with a running shell.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::session::{OutputSink, PtySession, SpawnOpts};
use super::types::TerminalSessionInfo;

/// Hard cap on concurrently LIVE sessions (decision 7). Spawning beyond it is a
/// user-visible error, never an eviction of an existing shell. Mirrored web-side by
/// `TERMINAL_SESSION_CAP` (both must move together — the web constant only disables
/// the new-tab affordance; this is the authoritative guard).
pub(crate) const MAX_LIVE_SESSIONS: usize = 12;

/// The registry of live PTY sessions + the scrollback persist location.
pub struct TerminalRegistry {
    sessions: Mutex<HashMap<String, PtySession>>,
    persist_root: Mutex<PathBuf>,
    cap: usize,
}

impl TerminalRegistry {
    /// A registry persisting scrollback under `persist_root`.
    pub fn new(persist_root: PathBuf) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            persist_root: Mutex::new(persist_root),
            cap: MAX_LIVE_SESSIONS,
        }
    }

    /// Point scrollback persistence at a new dir (project switch). In-memory
    /// sessions are untouched — they are global and survive the switch.
    pub fn retarget(&self, dir: PathBuf) {
        if let Ok(mut root) = self.persist_root.lock() {
            *root = dir;
        }
    }

    /// The current scrollback persist dir (for the persisted-list/read commands).
    pub fn persist_dir(&self) -> PathBuf {
        self.persist_root
            .lock()
            .map(|p| p.clone())
            .unwrap_or_default()
    }

    /// Spawn a shell in `opts.cwd`, streaming coalesced output into `sink`. Errors
    /// (user-visibly) when the live-session cap is reached, or when a confined
    /// spawn's Seatbelt profile can't be assembled (fail-closed).
    pub fn spawn(&self, opts: SpawnOpts, sink: OutputSink) -> Result<TerminalSessionInfo, String> {
        let mut sessions = self.lock_sessions()?;
        reap_dead(&mut sessions);
        if sessions.len() >= self.cap {
            return Err(format!(
                "terminal session limit reached ({} open, max {}) — close one before opening another",
                sessions.len(),
                self.cap
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let dir = self.persist_dir();
        let session = PtySession::spawn(id.clone(), opts, sink, dir)?;
        let info = session.info();
        sessions.insert(id, session);
        Ok(info)
    }

    /// Whether a live session with `id` is owned by THIS registry. The terminal
    /// backend (cockpit spec PR 6) routes write/resize/kill/set-title by ownership:
    /// a locally-owned (confined or pre-daemon) session is handled in-process, else
    /// the call proxies to the daemon.
    pub fn has(&self, id: &str) -> bool {
        self.lock_sessions()
            .map(|s| s.contains_key(id))
            .unwrap_or(false)
    }

    /// Forward user input to a session's shell.
    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.lock_sessions()?;
        sessions.get_mut(id).ok_or_else(|| no_such(id))?.write(data)
    }

    /// Set (or clear, with `None`) a live session's manual name (decision 5). The
    /// title lives behind the session's own `Mutex`, so an immutable session borrow
    /// suffices; the next scrollback flush persists it. Errors only for an unknown id.
    pub fn set_title(&self, id: &str, title: Option<String>) -> Result<(), String> {
        let sessions = self.lock_sessions()?;
        sessions
            .get(id)
            .ok_or_else(|| no_such(id))?
            .set_title(title);
        Ok(())
    }

    /// Resize a session's pty.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut sessions = self.lock_sessions()?;
        sessions
            .get_mut(id)
            .ok_or_else(|| no_such(id))?
            .resize(cols, rows)
    }

    /// Terminate a session and drop it from the registry. Idempotent — killing an
    /// already-gone session is a no-op success.
    pub fn kill(&self, id: &str) -> Result<(), String> {
        let mut sessions = self.lock_sessions()?;
        if let Some(mut session) = sessions.remove(id) {
            session.kill();
        }
        Ok(())
    }

    /// All live sessions (dead ones reaped first).
    pub fn list(&self) -> Vec<TerminalSessionInfo> {
        let Ok(mut sessions) = self.lock_sessions() else {
            return Vec::new();
        };
        reap_dead(&mut sessions);
        sessions.values().map(PtySession::info).collect()
    }

    /// Live sessions whose cwd is `dir` or under it — the cleanup-confirm seam for
    /// worktree merge/discard (decision 2; the dialog wiring lands in PR B).
    pub fn sessions_in_dir(&self, dir: &Path) -> Vec<TerminalSessionInfo> {
        let Ok(mut sessions) = self.lock_sessions() else {
            return Vec::new();
        };
        reap_dead(&mut sessions);
        sessions
            .values()
            .filter(|s| path_within(s.cwd(), dir))
            .map(PtySession::info)
            .collect()
    }

    fn lock_sessions(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, PtySession>>, String> {
        self.sessions
            .lock()
            .map_err(|_| "terminal registry lock poisoned".to_string())
    }

    #[cfg(test)]
    fn with_cap(persist_root: PathBuf, cap: usize) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            persist_root: Mutex::new(persist_root),
            cap,
        }
    }
}

/// Remove sessions whose shell has exited — their scrollback is already persisted
/// by the coalescer thread's exit flush, so dropping the entry loses nothing and
/// keeps the live-session count honest.
fn reap_dead(sessions: &mut HashMap<String, PtySession>) {
    sessions.retain(|_, s| s.is_alive());
}

fn no_such(id: &str) -> String {
    format!("no live terminal session {id}")
}

/// Whether `candidate` is `base` or under it, comparing canonicalized paths (a
/// worktree cwd and the dialog's dir may differ by symlinks — e.g. `/tmp` vs
/// `/private/tmp` on macOS). Falls back to the lexical path when canonicalization
/// fails (a since-deleted dir). `pub(crate)` so the terminal backend can apply the
/// same match to daemon-owned sessions when unioning `sessions_in_dir` (PR 6).
pub(crate) fn path_within(candidate: &Path, base: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(candidate).starts_with(canon(base))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn noop_sink() -> OutputSink {
        Box::new(|_bytes| {})
    }

    fn opts(cwd: &Path) -> SpawnOpts {
        SpawnOpts {
            cwd: cwd.to_path_buf(),
            confined: false,
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    #[cfg(unix)]
    fn cap_is_enforced_and_a_kill_frees_a_slot() {
        // Spawning past the live cap is a user-visible error, NOT an eviction; after
        // killing one, a new spawn succeeds. Uses a small cap so the test spawns few
        // real shells.
        let tmp = TempDir::new().unwrap();
        let reg = TerminalRegistry::with_cap(tmp.path().join("terminals"), 2);

        let a = reg.spawn(opts(tmp.path()), noop_sink()).expect("first");
        let _b = reg.spawn(opts(tmp.path()), noop_sink()).expect("second");
        let over = reg.spawn(opts(tmp.path()), noop_sink());
        assert!(
            over.err()
                .is_some_and(|e| e.contains("session limit reached")),
            "the third spawn must be refused at the cap"
        );

        reg.kill(&a.id).expect("kill");
        reg.spawn(opts(tmp.path()), noop_sink())
            .expect("a slot freed by kill allows a new spawn");
    }

    #[test]
    #[cfg(unix)]
    fn sessions_in_dir_matches_cwd_and_subpaths_only() {
        let tmp = TempDir::new().unwrap();
        let inside = tmp.path().join("wt");
        let outside = tmp.path().join("other");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let reg = TerminalRegistry::new(tmp.path().join("terminals"));

        let s = reg.spawn(opts(&inside), noop_sink()).expect("spawn");

        let matched = reg.sessions_in_dir(&inside);
        assert_eq!(matched.len(), 1, "the session in `inside` is found");
        assert_eq!(matched[0].id, s.id);
        // Its parent also contains it (subpath match).
        assert_eq!(reg.sessions_in_dir(tmp.path()).len(), 1);
        // A sibling dir contains nothing.
        assert!(reg.sessions_in_dir(&outside).is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn set_title_updates_the_live_descriptor_and_rejects_unknown_ids() {
        let tmp = TempDir::new().unwrap();
        let reg = TerminalRegistry::new(tmp.path().join("terminals"));
        let s = reg.spawn(opts(tmp.path()), noop_sink()).expect("spawn");
        assert_eq!(reg.list()[0].title, None, "a fresh session is unnamed");

        reg.set_title(&s.id, Some("deploy shell".to_string()))
            .expect("rename a live session");
        assert_eq!(reg.list()[0].title.as_deref(), Some("deploy shell"));

        // Clearing the name returns to the cwd-leaf fallback (None).
        reg.set_title(&s.id, None).expect("clear the name");
        assert_eq!(reg.list()[0].title, None);

        assert!(
            reg.set_title("ghost", Some("x".to_string())).is_err(),
            "renaming an unknown id errors"
        );
        reg.kill(&s.id).expect("kill");
    }

    #[test]
    #[cfg(unix)]
    fn write_and_list_reflect_a_live_session() {
        let tmp = TempDir::new().unwrap();
        let reg = TerminalRegistry::new(tmp.path().join("terminals"));
        let s = reg.spawn(opts(tmp.path()), noop_sink()).expect("spawn");
        assert_eq!(reg.list().len(), 1);
        reg.write(&s.id, b"echo hi\n")
            .expect("write to a live session");
        assert!(
            reg.write("ghost", b"x").is_err(),
            "writing to an unknown id errors"
        );
        reg.kill(&s.id).expect("kill");
        assert!(
            reg.list().is_empty(),
            "a killed session drops from the list"
        );
    }
}
