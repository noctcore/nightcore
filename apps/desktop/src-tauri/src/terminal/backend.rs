//! The terminal backend dispatcher (cockpit spec PR 6) — the managed-state seam the
//! command layer drives, hiding whether a session is owned **in-process** (today's
//! path) or by the **detached daemon** (§5).
//!
//! ## Degrade-to-today is the invariant
//! When the daemon is disabled (default), unsupported (Windows, §5.6), or unreachable,
//! EVERY method routes to the in-process [`TerminalRegistry`] — byte-for-byte the
//! shipped behavior, read-only restore and all. The daemon is a pure capability add:
//! it can only ever make live sessions *survive a restart*; it can never regress the
//! fallback.
//!
//! ## Ownership routing
//!  - **Confined** (Seatbelt) sessions are daemon-EXEMPT (§5.5) — always local, so a
//!    confined tab dies with the app and read-only-restores like today.
//!  - An unconfined spawn goes to the daemon when it is enabled + reachable, else
//!    local.
//!  - write/resize/kill/set-title route by ownership: `local.has(id)` ⇒ in-process,
//!    else the daemon. `list` / `sessions_in_dir` UNION both so the cleanup interlock
//!    (PR 5) and the tab list see daemon sessions too.

use std::path::{Path, PathBuf};

use super::{OutputSink, SpawnOpts, TerminalRegistry, TerminalSessionInfo, TitleSource};
use crate::terminal::types::TerminalDaemonStatus;

// The path-containment match is only applied to daemon sessions (Unix); the local
// registry already filters its own `sessions_in_dir`.
#[cfg(unix)]
use super::registry::path_within;

#[cfg(unix)]
use std::sync::{Arc, Mutex};
#[cfg(unix)]
use std::time::Duration;

/// The one terminal seam the commands hold in managed state.
pub struct TerminalBackend {
    /// Owns confined sessions always, and ALL sessions when the daemon is off /
    /// unsupported / unreachable (the degrade-to-today path).
    local: TerminalRegistry,
    /// The user's `terminal_daemon_enabled` opt-in, read once at boot (a running app
    /// keeps whatever backend it booted with — the toggle takes effect next relaunch).
    daemon_enabled: bool,
    /// The lazily-connected daemon client (Unix only). `None` until an unconfined
    /// spawn (or a reattach) connects one; reset to `None` on a project switch or a
    /// dropped connection so the next op reconnects/degrades.
    #[cfg(unix)]
    daemon_client: Mutex<Option<Arc<super::daemon::DaemonClient>>>,
}

impl TerminalBackend {
    /// A backend persisting local scrollback under `persist_dir`. `daemon_enabled`
    /// comes from settings; it is inert on an unsupported platform.
    pub fn new(persist_dir: PathBuf, daemon_enabled: bool) -> Self {
        Self {
            local: TerminalRegistry::new(persist_dir),
            daemon_enabled,
            #[cfg(unix)]
            daemon_client: Mutex::new(None),
        }
    }

    /// Point local scrollback persistence at a new dir (project switch) and drop any
    /// daemon connection so the next op connects to the NEW project's daemon. The old
    /// project's daemon keeps its sessions and idle-exits on its own.
    pub fn retarget(&self, dir: PathBuf) {
        self.local.retarget(dir);
        #[cfg(unix)]
        if let Ok(mut slot) = self.daemon_client.lock() {
            *slot = None;
        }
    }

    /// The current local scrollback persist dir (for the persisted list/read
    /// commands). The daemon persists to the SAME dir, so read-only restore covers
    /// both even after a daemon kill (§5.4).
    pub fn persist_dir(&self) -> PathBuf {
        self.local.persist_dir()
    }

    /// Spawn a shell. Confined ⇒ always in-process (§5.5). Unconfined ⇒ the daemon
    /// when reachable (so it survives a restart), else in-process. A daemon that is
    /// enabled but unreachable transparently degrades to local here.
    pub fn spawn(&self, opts: SpawnOpts, sink: OutputSink) -> Result<TerminalSessionInfo, String> {
        #[cfg(unix)]
        if !opts.confined {
            if let Some(client) = self.ensure_daemon() {
                let cwd = opts.cwd.to_string_lossy().into_owned();
                return client.create(cwd, opts.cols, opts.rows, sink);
            }
        }
        self.local.spawn(opts, sink)
    }

    /// Reattach to an existing daemon session on relaunch (§5.3): subscribe from the
    /// start of the replay ring and stream into `sink`. Only meaningful in daemon
    /// mode — the web calls this only for sessions `terminal_list` reported live but
    /// which have no local xterm instance yet.
    #[allow(unused_variables)]
    pub fn attach(&self, id: &str, sink: OutputSink) -> Result<TerminalSessionInfo, String> {
        #[cfg(unix)]
        if let Some(client) = self.ensure_daemon() {
            client.attach(id, 0, sink)?;
            return client
                .list()
                .into_iter()
                .find(|s| s.id == id)
                .ok_or_else(|| format!("no daemon session {id} to reattach"));
        }
        Err(format!("no live terminal session {id} to reattach"))
    }

    /// Set (or clear) a live session's title with its precedence `source` (round-2
    /// PR A), routed by ownership. The guarded write (local or daemon registry) decides
    /// whether it lands; the applied state is read back via [`Self::list`] by callers
    /// that need it (`terminal_suggest_title`).
    pub fn set_title(
        &self,
        id: &str,
        title: Option<String>,
        source: TitleSource,
    ) -> Result<(), String> {
        if self.local.has(id) {
            return self.local.set_title(id, title, source).map(|_| ());
        }
        #[cfg(unix)]
        if let Some(client) = self.current_daemon() {
            return client.set_title(id, title, source);
        }
        self.local.set_title(id, title, source).map(|_| ())
    }

    /// Forward user input, routed by ownership.
    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        if self.local.has(id) {
            return self.local.write(id, data);
        }
        #[cfg(unix)]
        if let Some(client) = self.current_daemon() {
            return client.write(id, data);
        }
        self.local.write(id, data)
    }

    /// Resize a session's pty, routed by ownership.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if self.local.has(id) {
            return self.local.resize(id, cols, rows);
        }
        #[cfg(unix)]
        if let Some(client) = self.current_daemon() {
            return client.resize(id, cols, rows);
        }
        self.local.resize(id, cols, rows)
    }

    /// Terminate a session, routed by ownership (idempotent). A daemon kill also
    /// frees its client sink; the trailing local kill is a no-op success.
    pub fn kill(&self, id: &str) -> Result<(), String> {
        if self.local.has(id) {
            return self.local.kill(id);
        }
        #[cfg(unix)]
        if let Some(client) = self.current_daemon() {
            let _ = client.kill(id);
        }
        self.local.kill(id)
    }

    /// All live sessions — the UNION of local + daemon (deduped by id, local winning).
    /// Uses `ensure_daemon` (not the check-only `current_daemon`) so the FIRST list on
    /// relaunch CONNECTS to (or warms) the daemon and discovers the sessions that
    /// survived — that discovery is what drives the web's reattach. Off / unsupported ⇒
    /// `ensure_daemon` returns `None` and this is exactly `local.list()`.
    pub fn list(&self) -> Vec<TerminalSessionInfo> {
        let mut out = self.local.list();
        #[cfg(unix)]
        if let Some(client) = self.ensure_daemon() {
            let known: std::collections::HashSet<String> =
                out.iter().map(|s| s.id.clone()).collect();
            for s in client.list() {
                if !known.contains(&s.id) {
                    out.push(s);
                }
            }
        }
        out
    }

    /// Live sessions whose cwd is `dir` or under it — the cleanup-interlock seam (PR
    /// 5). Unions daemon sessions so a merge/discard is still blocked when a
    /// daemon-owned terminal is open in the worktree. Uses `ensure_daemon` so a
    /// terminal that SURVIVED into a still-running daemon is discovered even before the
    /// user opens the Terminal view this launch (the interlock must never miss one).
    pub fn sessions_in_dir(&self, dir: &Path) -> Vec<TerminalSessionInfo> {
        let mut out = self.local.sessions_in_dir(dir);
        #[cfg(unix)]
        if let Some(client) = self.ensure_daemon() {
            let known: std::collections::HashSet<String> =
                out.iter().map(|s| s.id.clone()).collect();
            for s in client.list() {
                if !known.contains(&s.id) && path_within(Path::new(&s.cwd), dir) {
                    out.push(s);
                }
            }
        }
        out
    }

    /// The daemon's informational status (for the Settings toggle + dogfood).
    pub fn daemon_status(&self) -> TerminalDaemonStatus {
        TerminalDaemonStatus {
            enabled: self.daemon_enabled,
            supported: super::daemon::daemon_supported(),
            active: self.daemon_active(),
        }
    }

    #[cfg(unix)]
    fn daemon_active(&self) -> bool {
        self.current_daemon().is_some()
    }

    #[cfg(not(unix))]
    fn daemon_active(&self) -> bool {
        false
    }

    /// Return an ensured, alive daemon client (connecting or spawning the daemon if
    /// needed), or `None` when the daemon is disabled / unsupported / unreachable —
    /// in which case the caller degrades to `local`.
    #[cfg(unix)]
    fn ensure_daemon(&self) -> Option<Arc<super::daemon::DaemonClient>> {
        if !self.daemon_enabled || !super::daemon::daemon_supported() {
            return None;
        }
        let mut slot = self.daemon_client.lock().ok()?;
        if let Some(client) = slot.as_ref() {
            if client.is_alive() {
                return Some(Arc::clone(client));
            }
            *slot = None;
        }
        let persist_dir = self.local.persist_dir();
        let socket = super::daemon::socket_path(&persist_dir).ok()?;
        let client = connect_or_spawn(&socket, &persist_dir)?;
        let arc = Arc::new(client);
        *slot = Some(Arc::clone(&arc));
        Some(arc)
    }

    /// The already-connected daemon client (no spawn) for routing existing-session
    /// ops, or `None` when there is no live connection.
    #[cfg(unix)]
    fn current_daemon(&self) -> Option<Arc<super::daemon::DaemonClient>> {
        if !self.daemon_enabled {
            return None;
        }
        let slot = self.daemon_client.lock().ok()?;
        slot.as_ref().filter(|c| c.is_alive()).map(Arc::clone)
    }
}

/// Connect to the daemon, spawning + retrying if none is listening. A present socket
/// after a refused connect is stale (a live daemon would have answered), so it is
/// unlinked before the detached spawn — which also unlinks-then-binds, for safety.
#[cfg(unix)]
fn connect_or_spawn(socket: &Path, persist_dir: &Path) -> Option<super::daemon::DaemonClient> {
    if let Ok((client, _sessions)) = super::daemon::DaemonClient::connect(socket) {
        return Some(client);
    }
    let _ = std::fs::remove_file(socket);
    if super::daemon::spawn_detached(socket, persist_dir, super::daemon::DEFAULT_IDLE_GRACE_SECS)
        .is_err()
    {
        return None;
    }
    // The daemon binds asynchronously; retry the connect briefly (~2s total).
    for _ in 0..40 {
        std::thread::sleep(Duration::from_millis(50));
        if let Ok((client, _sessions)) = super::daemon::DaemonClient::connect(socket) {
            return Some(client);
        }
    }
    None
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
    fn daemon_off_reports_disabled_and_matches_platform_support() {
        let tmp = TempDir::new().unwrap();
        let backend = TerminalBackend::new(tmp.path().join("terminals"), false);
        let status = backend.daemon_status();
        assert!(!status.enabled, "the opt-in is off");
        assert!(!status.active, "no daemon connects when the flag is off");
        assert_eq!(
            status.supported,
            crate::terminal::daemon::daemon_supported(),
            "support reflects the platform regardless of the opt-in"
        );
    }

    #[test]
    #[cfg(unix)]
    fn daemon_off_routes_every_op_to_the_in_process_registry() {
        // The no-regression invariant: with the daemon off (default), spawn/list/write/
        // set-title/kill behave EXACTLY like the shipped in-process registry.
        let tmp = TempDir::new().unwrap();
        let backend = TerminalBackend::new(tmp.path().join("terminals"), false);

        let info = backend.spawn(opts(tmp.path()), noop_sink()).expect("spawn");
        assert_eq!(backend.list().len(), 1, "the spawned session is listed");
        assert_eq!(backend.list()[0].id, info.id);

        backend.write(&info.id, b"echo hi\n").expect("write");
        backend
            .set_title(&info.id, Some("deploy".to_string()), TitleSource::Manual)
            .expect("set title");
        assert_eq!(backend.list()[0].title.as_deref(), Some("deploy"));
        assert_eq!(backend.list()[0].title_source, Some(TitleSource::Manual));

        // `attach` has nothing to reattach with the daemon off.
        assert!(backend.attach(&info.id, noop_sink()).is_err());

        backend.kill(&info.id).expect("kill");
        assert!(backend.list().is_empty(), "a killed session drops");
    }

    #[test]
    #[cfg(unix)]
    fn sessions_in_dir_matches_local_when_the_daemon_is_off() {
        let tmp = TempDir::new().unwrap();
        let backend = TerminalBackend::new(tmp.path().join("terminals"), false);
        let info = backend.spawn(opts(tmp.path()), noop_sink()).expect("spawn");
        assert_eq!(backend.sessions_in_dir(tmp.path()).len(), 1);
        assert!(backend.sessions_in_dir(&tmp.path().join("nope")).is_empty());
        backend.kill(&info.id).expect("kill");
    }
}
