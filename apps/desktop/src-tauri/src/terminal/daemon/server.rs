//! The detached PTY daemon process (cockpit spec PR 6, §5.1). Unix-only (§5.6).
//!
//! Re-invoked from `--terminal-daemon`, this owns the live PTYs so they outlive the
//! app window. It reuses the SAME `terminal::session` machinery as the in-process
//! backend — the only difference is the host process. Clients (the app) connect over
//! the owner-only Unix socket and drive create/write/resize/kill/list; a session's
//! output rides a per-session [`Fanout`] that buffers a replay tail + streams live
//! frames to the subscribed client.
//!
//! **USER-ONLY seam (re-asserted, §5.7).** The socket is owner-only (`0700` dir /
//! `0600` socket), local, and speaks ONLY to the app's command layer — never to any
//! engine / sidecar / provider path. No agent can reach it. The daemon holds only a
//! bounded replay ring (not full history); the on-disk scrollback stays owner-only
//! and export-excluded, same as the in-process path.

#![cfg(unix)]

use std::collections::HashMap;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::discovery;
use super::fanout::{ClientWriter, Fanout};
use super::protocol::{self, ClientMessage, Frame, ServerMessage, PROTOCOL_VERSION};
use crate::terminal::{OutputSink, SpawnOpts, TerminalRegistry, TitleSource};

/// How often the idle monitor checks whether the daemon should self-exit.
const IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(5);

/// Shared daemon state: the reused session registry + a fanout per session + a live
/// client count (for idle self-exit) + the uid the daemon is allowed to serve.
pub(crate) struct Server {
    registry: TerminalRegistry,
    fanouts: Mutex<HashMap<String, Arc<Fanout>>>,
    client_count: AtomicUsize,
    /// The only uid this daemon serves (§5.2 peer-cred). Every accepted connection's
    /// kernel-reported peer uid must equal this or it is refused. Defaults to the
    /// daemon's own euid in production; a test injects a mismatching value to drive the
    /// reject path without a second OS user.
    expected_uid: u32,
}

impl Server {
    pub(crate) fn new(persist_dir: PathBuf) -> Self {
        Self::with_expected_uid(persist_dir, discovery::euid())
    }

    /// A server that serves only `expected_uid`. `new` uses the daemon's own euid; the
    /// daemon integration tests pass a different uid to exercise the peer-cred refusal.
    pub(crate) fn with_expected_uid(persist_dir: PathBuf, expected_uid: u32) -> Self {
        Self {
            registry: TerminalRegistry::new(persist_dir),
            fanouts: Mutex::new(HashMap::new()),
            client_count: AtomicUsize::new(0),
            expected_uid,
        }
    }

    /// Whether the daemon is idle: no connected clients AND no live sessions. The
    /// monitor exits the process once this has held continuously for the grace.
    fn is_idle(&self) -> bool {
        self.client_count.load(Ordering::SeqCst) == 0 && self.registry.list().is_empty()
    }

    /// Accept + serve connections until `stop` is set. Each connection runs on its own
    /// thread. In production `stop` never fires (idle-exit is `process::exit` from the
    /// monitor); tests set it + self-connect to unblock the pending `accept`.
    pub(crate) fn serve(self: &Arc<Self>, listener: UnixListener, stop: Arc<AtomicBool>) {
        for incoming in listener.incoming() {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = incoming else { continue };
            // Peer-cred (§5.2): refuse any connection whose owning uid is not ours,
            // BEFORE it is handed a handler thread. A refused peer is dropped here (its
            // handshake never completes → the app degrades to in-process).
            if !self.peer_authorized(&stream) {
                continue;
            }
            let server = Arc::clone(self);
            std::thread::spawn(move || server.handle_connection(stream));
        }
    }

    /// Whether the connecting peer is the owning user (§5.2 peer-cred). On a uid
    /// mismatch OR any error reading the peer credential, log at WARN and refuse —
    /// fail-closed, so a spoofed / unreadable peer is never served. Refusing costs only
    /// this one daemon connection; the app still degrades to the in-process PTY.
    fn peer_authorized(&self, stream: &UnixStream) -> bool {
        match discovery::peer_uid(stream) {
            Ok(uid) if uid == self.expected_uid => true,
            Ok(uid) => {
                tracing::warn!(
                    target: "terminal-daemon",
                    "refused a daemon connection from uid {uid} (serves uid {})",
                    self.expected_uid
                );
                false
            }
            Err(e) => {
                tracing::warn!(
                    target: "terminal-daemon",
                    "refused a daemon connection: could not read peer credential: {e}"
                );
                false
            }
        }
    }

    /// One client connection: read frames, dispatch commands, write replies. Output
    /// frames the client subscribed to are written from the session pump threads via
    /// the shared writer, not here.
    fn handle_connection(self: Arc<Self>, stream: UnixStream) {
        self.client_count.fetch_add(1, Ordering::SeqCst);
        let writer: ClientWriter = match stream.try_clone() {
            Ok(w) => Arc::new(Mutex::new(w)),
            Err(_) => {
                self.client_count.fetch_sub(1, Ordering::SeqCst);
                return;
            }
        };
        let mut read_stream = stream;
        loop {
            match protocol::read_frame(&mut read_stream) {
                Ok(Some(Frame::Control(payload))) => match protocol::decode_client(&payload) {
                    Ok(msg) => {
                        let reply = self.handle_message(msg, &writer);
                        if reply_and_maybe_stop(&writer, reply) {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = send(
                            &writer,
                            ServerMessage::Error {
                                message: "undecodable control frame".to_string(),
                            },
                        );
                        break;
                    }
                },
                // A client never sends output frames; ignore a stray one.
                Ok(Some(Frame::Output(_))) => {}
                Ok(None) | Err(_) => break,
            }
        }
        // Connection gone: drop its subscriptions so the fanouts don't keep writing to
        // a dead socket, and decrement the client count (arming idle-exit).
        if let Ok(fanouts) = self.fanouts.lock() {
            for fanout in fanouts.values() {
                fanout.clear_subscriber(&writer);
            }
        }
        self.client_count.fetch_sub(1, Ordering::SeqCst);
    }

    /// Dispatch one decoded client message to a reply. `Subscribe` additionally
    /// installs the connection's `writer` as the session's live subscriber.
    fn handle_message(&self, msg: ClientMessage, writer: &ClientWriter) -> ServerMessage {
        match msg {
            ClientMessage::Hello { version: _ } => ServerMessage::HelloAck {
                version: PROTOCOL_VERSION,
                sessions: self.registry.list(),
            },
            ClientMessage::Create { cwd, cols, rows } => self.create(cwd, cols, rows),
            ClientMessage::Write { id, bytes } => match self.registry.write(&id, &bytes) {
                Ok(()) => ServerMessage::Ok,
                Err(message) => ServerMessage::Error { message },
            },
            ClientMessage::Resize { id, cols, rows } => {
                match self.registry.resize(&id, cols, rows) {
                    Ok(()) => ServerMessage::Ok,
                    Err(message) => ServerMessage::Error { message },
                }
            }
            ClientMessage::SetTitle { id, title, source } => {
                // A missing source (an older app) is treated as `Manual`, matching the
                // pre-feature unconditional set; a new app always sends a concrete one.
                let source = source.unwrap_or(TitleSource::Manual);
                match self.registry.set_title(&id, title, source) {
                    Ok(_) => ServerMessage::Ok,
                    Err(message) => ServerMessage::Error { message },
                }
            }
            ClientMessage::Kill { id } => {
                let _ = self.registry.kill(&id);
                self.fanouts.lock().ok().and_then(|mut f| f.remove(&id));
                ServerMessage::Ok
            }
            ClientMessage::List => ServerMessage::Sessions {
                sessions: self.registry.list(),
            },
            ClientMessage::Subscribe { id, since_seq } => self.subscribe(&id, since_seq, writer),
            ClientMessage::Ping => ServerMessage::Pong,
        }
    }

    /// Spawn a session and wire its output into a new [`Fanout`]. The session sink
    /// feeds a channel a pump thread drains into the fanout: the channel buffers the
    /// banner/first-prompt bytes emitted before the id (and thus the fanout) is known,
    /// so nothing is lost before the app subscribes.
    fn create(&self, cwd: String, cols: u16, rows: u16) -> ServerMessage {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let sink: OutputSink = Box::new(move |bytes| {
            let _ = tx.send(bytes);
        });
        let opts = SpawnOpts {
            cwd: PathBuf::from(cwd),
            // Confined sessions are daemon-EXEMPT (§5.5) — the app never asks the
            // daemon to create one, so a daemon-owned session is always unconfined.
            confined: false,
            cols,
            rows,
        };
        let info = match self.registry.spawn(opts, sink) {
            Ok(info) => info,
            Err(message) => return ServerMessage::Error { message },
        };
        let fanout = Arc::new(Fanout::new(info.id.clone()));
        if let Ok(mut fanouts) = self.fanouts.lock() {
            fanouts.insert(info.id.clone(), Arc::clone(&fanout));
        }
        std::thread::spawn(move || {
            while let Ok(bytes) = rx.recv() {
                fanout.emit(bytes);
            }
        });
        ServerMessage::Created { info }
    }

    /// Install `writer` as `id`'s live subscriber and replay its tail from `since_seq`.
    fn subscribe(&self, id: &str, since_seq: u64, writer: &ClientWriter) -> ServerMessage {
        let fanout = self.fanouts.lock().ok().and_then(|f| f.get(id).cloned());
        match fanout {
            Some(fanout) => {
                fanout.subscribe(writer.clone(), since_seq);
                ServerMessage::Ok
            }
            None => ServerMessage::Error {
                message: format!("no daemon session {id} to subscribe"),
            },
        }
    }
}

/// Send a reply; return `true` when the connection should close (write failed).
fn reply_and_maybe_stop(writer: &ClientWriter, reply: ServerMessage) -> bool {
    send(writer, reply).is_err()
}

fn send(writer: &ClientWriter, msg: ServerMessage) -> std::io::Result<()> {
    let mut w = writer
        .lock()
        .map_err(|_| std::io::Error::other("client writer poisoned"))?;
    protocol::write_server(&mut *w, &msg)
}

/// Production entry (called by the `--terminal-daemon` argv dispatch): bind the
/// owner-only socket, arm the idle monitor, and serve forever. Never returns — it
/// `process::exit`s on idle or a fatal bind error, so the app's connect-retry finds
/// either a live daemon or a clean absence to respawn into.
pub(crate) fn run(socket: PathBuf, persist_dir: PathBuf, idle_secs: u64) -> ! {
    // A socket file present at daemon start is stale (the app only spawns a daemon
    // after failing to connect), so unlink before binding. If bind still fails,
    // another daemon won the race — exit and let the app connect to it.
    let _ = std::fs::remove_file(&socket);
    let listener = match UnixListener::bind(&socket) {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!(target: "terminal-daemon", "bind {socket:?} failed: {e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = discovery::set_socket_perms(&socket) {
        tracing::warn!(target: "terminal-daemon", "chmod 0600 {socket:?} failed: {e}");
    }
    let server = Arc::new(Server::new(persist_dir));
    spawn_idle_monitor(Arc::clone(&server), Duration::from_secs(idle_secs));
    let never = Arc::new(AtomicBool::new(false));
    server.serve(listener, never);
    std::process::exit(0);
}

/// Self-exit once idle (no clients AND no sessions) for the grace (§5.4). Runs on a
/// background thread so the accept loop owns the main thread.
fn spawn_idle_monitor(server: Arc<Server>, grace: Duration) {
    std::thread::spawn(move || {
        let mut idle_since: Option<Instant> = None;
        loop {
            std::thread::sleep(IDLE_CHECK_INTERVAL);
            if server.is_idle() {
                match idle_since {
                    Some(since) if since.elapsed() >= grace => {
                        tracing::info!(target: "terminal-daemon", "idle for the grace — exiting");
                        std::process::exit(0);
                    }
                    Some(_) => {}
                    None => idle_since = Some(Instant::now()),
                }
            } else {
                idle_since = None;
            }
        }
    });
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Helpers the daemon integration tests use to drive a [`Server`] against a real
    //! socket WITHOUT the process-exiting production `run` (which is untestable in a
    //! shared test binary).
    use super::*;

    /// A running in-process daemon for tests: binds a temp socket, serves on a thread,
    /// and stops cleanly on drop.
    pub(crate) struct TestDaemon {
        pub(crate) socket: PathBuf,
        stop: Arc<AtomicBool>,
    }

    impl TestDaemon {
        /// A daemon that serves OUR uid (the production default), so a same-process
        /// client is accepted.
        pub(crate) fn start(socket: PathBuf, persist_dir: PathBuf) -> Self {
            Self::start_as(socket, persist_dir, discovery::euid())
        }

        /// A daemon that serves `expected_uid`. A peer-cred test passes a uid other than
        /// our own so the same-process connection — which the kernel reports at OUR uid
        /// — is refused, exercising the reject path without a second OS user.
        pub(crate) fn start_as(socket: PathBuf, persist_dir: PathBuf, expected_uid: u32) -> Self {
            let listener = UnixListener::bind(&socket).expect("bind test socket");
            let _ = discovery::set_socket_perms(&socket);
            let server = Arc::new(Server::with_expected_uid(persist_dir, expected_uid));
            let stop = Arc::new(AtomicBool::new(false));
            let serve_stop = Arc::clone(&stop);
            std::thread::spawn(move || server.serve(listener, serve_stop));
            Self { socket, stop }
        }
    }

    impl Drop for TestDaemon {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            // Unblock the pending `accept` so the serve thread observes `stop`.
            let _ = UnixStream::connect(&self.socket);
            let _ = std::fs::remove_file(&self.socket);
        }
    }
}
