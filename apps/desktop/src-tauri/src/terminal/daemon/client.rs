//! The app-side IPC client for the detached PTY daemon (cockpit spec PR 6, §5.2).
//! Unix-only (§5.6).
//!
//! Owns one connection to the daemon's owner-only socket. A background reader thread
//! demultiplexes the stream: binary **output** frames route to the per-session sink
//! (the same `InvokeResponseBody::Raw` bridge the shipped web already consumes, §9
//! trap g), while JSON **control** replies go to a response channel a serialized RPC
//! awaits. Every method degrades cleanly: once the socket dies, [`is_alive`] is
//! `false` and the backend falls back to the in-process PTY + read-only restore.

#![cfg(unix)]

use std::collections::HashMap;
use std::io;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::protocol::{self, ClientMessage, Frame, ServerMessage, PROTOCOL_VERSION};
use crate::terminal::{OutputSink, TerminalSessionInfo};

/// How long an RPC waits for its control reply before declaring the daemon wedged.
/// Generous for a local socket; a timeout marks the client dead → the backend
/// degrades rather than hanging the UI.
const RPC_TIMEOUT: Duration = Duration::from_secs(10);

/// A connected daemon client. Cheap to share behind an `Arc` in the terminal backend.
pub(crate) struct DaemonClient {
    /// Shared write half — RPC frames go out through it (serialized by `cmd_lock`).
    write: Mutex<UnixStream>,
    /// Serializes RPCs so each control reply pairs with its request.
    cmd_lock: Mutex<()>,
    /// Control replies from the reader thread (output frames never land here).
    responses: Mutex<Receiver<ServerMessage>>,
    /// Per-session output sinks (the Channel `Raw` bridge), keyed by session id.
    sinks: Arc<Mutex<HashMap<String, OutputSink>>>,
    /// Cleared by the reader thread on EOF/error so RPCs fail fast → backend degrades.
    alive: Arc<AtomicBool>,
}

impl DaemonClient {
    /// Connect to the daemon at `socket` and negotiate: send `Hello`, require a
    /// matching `HelloAck` version, and return the daemon's live sessions (for
    /// reattach). A refused connection (no daemon) or a version the app can't speak is
    /// an `Err` — the backend then spawns/replaces the daemon or degrades.
    pub(crate) fn connect(socket: &Path) -> io::Result<(Self, Vec<TerminalSessionInfo>)> {
        let stream = UnixStream::connect(socket)?;
        let reader = stream.try_clone()?;
        let write = Mutex::new(stream);
        let (tx, rx) = mpsc::channel::<ServerMessage>();
        let sinks: Arc<Mutex<HashMap<String, OutputSink>>> = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        spawn_reader(reader, tx, Arc::clone(&sinks), Arc::clone(&alive));

        let client = Self {
            write,
            cmd_lock: Mutex::new(()),
            responses: Mutex::new(rx),
            sinks,
            alive,
        };
        let sessions = client.hello()?;
        Ok((client, sessions))
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// The negotiation handshake — also the on-connect liveness check (a wedged daemon
    /// that never acks times out here → `Err` → the backend replaces it).
    fn hello(&self) -> io::Result<Vec<TerminalSessionInfo>> {
        match self.request(ClientMessage::Hello {
            version: PROTOCOL_VERSION,
        })? {
            ServerMessage::HelloAck { version, sessions } if version == PROTOCOL_VERSION => {
                Ok(sessions)
            }
            ServerMessage::HelloAck { version, .. } => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                format!("daemon protocol v{version} != app v{PROTOCOL_VERSION}; falling back"),
            )),
            other => Err(io::Error::other(format!(
                "unexpected hello reply: {other:?}"
            ))),
        }
    }

    /// Spawn an (unconfined) session on the daemon and register `sink` for its output,
    /// then subscribe so the daemon streams it. Output only flows after `Subscribe`,
    /// so registering the sink between `Created` and `Subscribe` loses nothing.
    pub(crate) fn create(
        &self,
        cwd: String,
        cols: u16,
        rows: u16,
        sink: OutputSink,
    ) -> Result<TerminalSessionInfo, String> {
        let info = match self.request_str(ClientMessage::Create { cwd, cols, rows })? {
            ServerMessage::Created { info } => info,
            ServerMessage::Error { message } => return Err(message),
            other => return Err(format!("unexpected create reply: {other:?}")),
        };
        self.register_sink(info.id.clone(), sink);
        // Subscribe from 0 — a fresh session's ring holds only its banner/first prompt.
        self.subscribe(&info.id, 0)?;
        Ok(info)
    }

    /// Reattach to an EXISTING daemon session (relaunch, §5.3): register `sink` then
    /// subscribe from `since_seq` (0 for a fresh xterm) so the daemon replays the
    /// buffered tail and streams live.
    pub(crate) fn attach(&self, id: &str, since_seq: u64, sink: OutputSink) -> Result<(), String> {
        self.register_sink(id.to_string(), sink);
        self.subscribe(id, since_seq)
    }

    fn subscribe(&self, id: &str, since_seq: u64) -> Result<(), String> {
        self.expect_ok(ClientMessage::Subscribe {
            id: id.to_string(),
            since_seq,
        })
    }

    pub(crate) fn write(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        self.expect_ok(ClientMessage::Write {
            id: id.to_string(),
            bytes: bytes.to_vec(),
        })
    }

    pub(crate) fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.expect_ok(ClientMessage::Resize {
            id: id.to_string(),
            cols,
            rows,
        })
    }

    pub(crate) fn set_title(&self, id: &str, title: Option<String>) -> Result<(), String> {
        self.expect_ok(ClientMessage::SetTitle {
            id: id.to_string(),
            title,
        })
    }

    pub(crate) fn kill(&self, id: &str) -> Result<(), String> {
        // Drop the sink first so a late frame can't write into a disposed target.
        self.forget_sink(id);
        self.expect_ok(ClientMessage::Kill { id: id.to_string() })
    }

    pub(crate) fn list(&self) -> Vec<TerminalSessionInfo> {
        match self.request_str(ClientMessage::List) {
            Ok(ServerMessage::Sessions { sessions }) => sessions,
            _ => Vec::new(),
        }
    }

    // --- internals ---------------------------------------------------------

    fn register_sink(&self, id: String, sink: OutputSink) {
        if let Ok(mut sinks) = self.sinks.lock() {
            sinks.insert(id, sink);
        }
    }

    fn forget_sink(&self, id: &str) {
        if let Ok(mut sinks) = self.sinks.lock() {
            sinks.remove(id);
        }
    }

    /// An RPC whose only success is `Ok` (write/resize/kill/set-title/subscribe).
    fn expect_ok(&self, msg: ClientMessage) -> Result<(), String> {
        match self.request_str(msg)? {
            ServerMessage::Ok => Ok(()),
            ServerMessage::Error { message } => Err(message),
            other => Err(format!("unexpected reply: {other:?}")),
        }
    }

    /// [`request`](Self::request) with the io error stringified for the command layer.
    fn request_str(&self, msg: ClientMessage) -> Result<ServerMessage, String> {
        self.request(msg).map_err(|e| e.to_string())
    }

    /// Serialized request/response: fail fast if the client is dead, else write the
    /// frame and await the next control reply.
    fn request(&self, msg: ClientMessage) -> io::Result<ServerMessage> {
        if !self.is_alive() {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "daemon connection is closed",
            ));
        }
        let _guard = self.cmd_lock.lock().map_err(|_| poisoned())?;
        {
            let mut w = self.write.lock().map_err(|_| poisoned())?;
            if let Err(e) = protocol::write_client(&mut *w, &msg) {
                self.alive.store(false, Ordering::SeqCst);
                return Err(e);
            }
        }
        let rx = self.responses.lock().map_err(|_| poisoned())?;
        match rx.recv_timeout(RPC_TIMEOUT) {
            Ok(reply) => Ok(reply),
            Err(_) => {
                self.alive.store(false, Ordering::SeqCst);
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "daemon did not reply in time",
                ))
            }
        }
    }
}

fn poisoned() -> io::Error {
    io::Error::other("daemon client mutex poisoned")
}

/// The reader thread: demultiplex frames — output → the session sink, control → the
/// RPC response channel. Clears `alive` on EOF/error so pending + future RPCs fail.
fn spawn_reader(
    mut reader: UnixStream,
    responses: mpsc::Sender<ServerMessage>,
    sinks: Arc<Mutex<HashMap<String, OutputSink>>>,
    alive: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        loop {
            match protocol::read_frame(&mut reader) {
                Ok(Some(Frame::Output(frame))) => {
                    // Route the raw bytes to the session's sink (the Channel bridge).
                    // Unknown ids (a subscribe not yet registered, or a killed session)
                    // are dropped.
                    if let Ok(sinks) = sinks.lock() {
                        if let Some(sink) = sinks.get(&frame.id) {
                            sink(frame.bytes);
                        }
                    }
                }
                Ok(Some(Frame::Control(payload))) => match protocol::decode_server(&payload) {
                    Ok(msg) => {
                        if responses.send(msg).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                },
                Ok(None) | Err(_) => break,
            }
        }
        alive.store(false, Ordering::SeqCst);
    });
}
