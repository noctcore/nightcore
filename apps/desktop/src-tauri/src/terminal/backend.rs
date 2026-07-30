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
//!
//! ## Governance stamping (#405)
//! This type is also the ONE place a session descriptor learns whether it is
//! **ungoverned** (task-linked / `claude`-launched). Neither the in-process registry
//! nor the daemon knows about the marker file; every descriptor that leaves here —
//! `spawn`, `attach`, `list`, `sessions_in_dir`, and the persisted-restore list/read —
//! passes through [`TerminalBackend::stamp`], which re-reads the on-disk marks. That is
//! why the marker survives a reload, an app restart, and a daemon restart.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::governance::{self, TerminalGovernanceReason};
use super::{
    OutputSink, PersistedTerminalInfo, PersistedTerminalScrollback, SpawnOpts, TerminalRegistry,
    TerminalSessionInfo, TitleSource,
};
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
                return client
                    .create(cwd, opts.cols, opts.rows, sink)
                    .map(|s| self.stamp(s));
            }
        }
        self.local.spawn(opts, sink).map(|s| self.stamp(s))
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
                // THE #405 case: a session that outlived the app reattaches here, and
                // the stamp is what re-lights its ungoverned bolt from disk.
                .map(|s| self.stamp(s))
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

    /// Terminate EVERY live session (local + daemon) — the "orphan kill-all" escape
    /// hatch (T14). Daemon-owned sessions can orphan invisibly on a project switch or
    /// a daemon toggle-off (the app loses its handle but the shells keep running); this
    /// is the user's one-click reap of all of them, paired with `daemon_status`. Kills
    /// the deduped union `list()` reports, routing each by ownership. Idempotent — a
    /// session that died between the list and the kill is a no-op success. Returns the
    /// number of distinct sessions it asked to terminate (for the UI's confirm toast).
    pub fn kill_all(&self) -> usize {
        let sessions = self.list();
        for session in &sessions {
            let _ = self.kill(&session.id);
        }
        sessions.len()
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
            let known: HashSet<String> = out.iter().map(|s| s.id.clone()).collect();
            for s in client.list() {
                if !known.contains(&s.id) {
                    out.push(s);
                }
            }
        }
        self.stamp_all(out)
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
            let known: HashSet<String> = out.iter().map(|s| s.id.clone()).collect();
            for s in client.list() {
                if !known.contains(&s.id) && path_within(Path::new(&s.cwd), dir) {
                    out.push(s);
                }
            }
        }
        self.stamp_all(out)
    }

    // --- Governance markers (#405) -----------------------------------------

    /// Record a governance marker against a session, persisted to disk so it survives
    /// a reload / app restart / daemon restart. Idempotent; errors on an unsafe id or
    /// an unwritable terminals dir.
    pub fn mark_ungoverned(&self, id: &str, reason: TerminalGovernanceReason) -> Result<(), String> {
        governance::mark(&self.persist_dir(), id, reason)
    }

    /// Clear a REVOCABLE governance marker (a task unlink). Refuses a sticky marker —
    /// a shell where `claude` ran can never be re-labelled governed.
    pub fn clear_governance_mark(
        &self,
        id: &str,
        reason: TerminalGovernanceReason,
    ) -> Result<(), String> {
        governance::unmark(&self.persist_dir(), id, reason)
    }

    /// Whether a session id currently carries any governance marker (read straight
    /// from disk).
    pub fn is_ungoverned(&self, id: &str) -> bool {
        governance::load(&self.persist_dir()).is_ungoverned(id)
    }

    /// Persisted (dead) sessions for the read-only restore UI, governance-stamped, with
    /// the marker file GC'd against the live ∪ persisted id set as a side effect. That
    /// GC point is deliberate: it is the only moment we know BOTH sets, and it never
    /// expires a marker by age (an old live shell must not quietly become "governed").
    pub fn list_persisted(&self) -> Vec<PersistedTerminalInfo> {
        let dir = self.persist_dir();
        let mut infos = super::persist::list(&dir);
        let mut keep: HashSet<String> = infos.iter().map(|i| i.id.clone()).collect();
        keep.extend(self.local.list().into_iter().map(|s| s.id));
        #[cfg(unix)]
        if let Some(client) = self.current_daemon() {
            keep.extend(client.list().into_iter().map(|s| s.id));
        }
        governance::retain(&dir, &keep);
        let marks = governance::load(&dir);
        for info in &mut infos {
            info.ungoverned = marks.is_ungoverned(&info.id);
        }
        infos
    }

    /// One persisted session's metadata + replay bytes, governance-stamped. `None`
    /// when absent / unparsable / an unsafe id.
    pub fn read_persisted(&self, id: &str) -> Option<PersistedTerminalScrollback> {
        let dir = self.persist_dir();
        let mut record = super::persist::read(&dir, id)?;
        record.info.ungoverned = governance::load(&dir).is_ungoverned(&record.info.id);
        Some(record)
    }

    /// Stamp one descriptor's `ungoverned` from disk.
    fn stamp(&self, mut session: TerminalSessionInfo) -> TerminalSessionInfo {
        session.ungoverned = self.is_ungoverned(&session.id);
        session
    }

    /// Stamp a whole list from ONE marker-file read (the list paths are the hot ones).
    fn stamp_all(&self, mut sessions: Vec<TerminalSessionInfo>) -> Vec<TerminalSessionInfo> {
        if sessions.is_empty() {
            return sessions;
        }
        let marks = governance::load(&self.persist_dir());
        for session in &mut sessions {
            session.ungoverned = marks.is_ungoverned(&session.id);
        }
        sessions
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
    fn an_ungoverned_marker_survives_a_backend_restart() {
        // THE #405 regression guard. `backend_a` is the running app: it spawns a shell
        // and the user launches `claude` in it. Then the whole backend is DROPPED —
        // every in-memory map (registry, daemon client slot, marker cache) goes with
        // it, exactly as on an app relaunch or a daemon restart. `backend_b` is the new
        // process: it shares nothing but the terminals dir on disk.
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("terminals");

        let backend_a = TerminalBackend::new(dir.clone(), false);
        let info = backend_a.spawn(opts(tmp.path()), noop_sink()).expect("spawn");
        assert!(
            !backend_a.list()[0].ungoverned,
            "a fresh shell starts governed"
        );

        backend_a
            .mark_ungoverned(&info.id, TerminalGovernanceReason::ClaudeLaunched)
            .expect("mark");
        assert!(
            backend_a.list()[0].ungoverned,
            "the marker lights up immediately"
        );

        backend_a.kill(&info.id).expect("kill");
        drop(backend_a); // ← the restart

        // The restart is only convincing if the marker really left the process. Assert
        // the BYTES first: an in-memory cache (the pre-#405 shape, and the shape a
        // future "optimization" might reintroduce) fails right here, because a dropped
        // struct proves nothing about a static.
        let on_disk = std::fs::read(dir.join("governance.json"))
            .expect("the marker was written to disk, not just remembered");
        let on_disk = String::from_utf8(on_disk).expect("utf-8 json");
        assert!(
            on_disk.contains(&info.id) && on_disk.contains("claudeLaunched"),
            "the file names the session and why it is ungoverned, got: {on_disk}"
        );

        // Now the cold read: a directory whose ONLY content is those bytes — nothing a
        // still-running process could have handed over — still yields the marker.
        let cold = tmp.path().join("cold-boot");
        std::fs::create_dir_all(&cold).unwrap();
        std::fs::write(cold.join("governance.json"), &on_disk).unwrap();
        assert!(
            TerminalBackend::new(cold, false).is_ungoverned(&info.id),
            "a backend built from nothing but the persisted bytes reports ungoverned"
        );

        let backend_b = TerminalBackend::new(dir.clone(), false);
        assert!(
            backend_b.is_ungoverned(&info.id),
            "the marker must be readable by a process that never saw the mark"
        );

        // …and the read-only restore tab carries it too. The killed shell's scrollback
        // lands via the coalescer's EOF flush on another thread, so poll for the file
        // before asserting on the restore list (the same wait `session.rs`'s
        // persist-on-exit test uses).
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline
            && crate::terminal::persist::read(&dir, &info.id).is_none()
        {
            std::thread::sleep(Duration::from_millis(50));
        }
        let restored = backend_b
            .list_persisted()
            .into_iter()
            .find(|p| p.id == info.id)
            .expect("the dead session read-only-restores");
        assert!(
            restored.ungoverned,
            "and the restored tab still says an agent ran in that shell"
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_task_unlink_clears_its_marker_but_a_claude_launch_is_permanent() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("terminals");
        let backend = TerminalBackend::new(dir, false);
        let info = backend.spawn(opts(tmp.path()), noop_sink()).expect("spawn");

        backend
            .mark_ungoverned(&info.id, TerminalGovernanceReason::TaskLinked)
            .expect("link");
        backend
            .clear_governance_mark(&info.id, TerminalGovernanceReason::TaskLinked)
            .expect("unlink");
        assert!(!backend.list()[0].ungoverned, "an unlink clears the marker");

        backend
            .mark_ungoverned(&info.id, TerminalGovernanceReason::ClaudeLaunched)
            .expect("launch");
        assert!(
            backend
                .clear_governance_mark(&info.id, TerminalGovernanceReason::ClaudeLaunched)
                .is_err(),
            "a claude-launch marker refuses to clear"
        );
        assert!(backend.list()[0].ungoverned, "so it is still marked");
        backend.kill(&info.id).expect("kill");
    }

    #[test]
    #[cfg(unix)]
    fn the_marker_file_is_gcd_for_sessions_that_are_neither_live_nor_persisted() {
        // `list_persisted` is the GC point. A marker for an id that is neither a live
        // session nor a persisted scrollback is forgotten; a LIVE session's marker is
        // kept even though it has no persisted file yet.
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("terminals");
        let backend = TerminalBackend::new(dir, false);
        let live = backend.spawn(opts(tmp.path()), noop_sink()).expect("spawn");
        backend
            .mark_ungoverned(&live.id, TerminalGovernanceReason::ClaudeLaunched)
            .expect("mark live");
        backend
            .mark_ungoverned("long-forgotten", TerminalGovernanceReason::TaskLinked)
            .expect("mark stale");

        backend.list_persisted();

        assert!(
            backend.is_ungoverned(&live.id),
            "a live session's marker is never GC'd out from under it"
        );
        assert!(
            !backend.is_ungoverned("long-forgotten"),
            "a marker for a session nothing remembers is collected"
        );
        backend.kill(&live.id).expect("kill");
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
