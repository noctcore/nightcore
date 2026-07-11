//! The detached-PTY-daemon wire protocol (cockpit spec PR 6, §5.2).
//!
//! Two frame kinds ride the same length-prefixed stream:
//!  - **Control** (`0x01`): a JSON-encoded [`ClientMessage`] / [`ServerMessage`] —
//!    the low-volume command/response channel (create/write/resize/kill/list/…).
//!  - **Output** (`0x02`): a session's raw PTY bytes with a sequence number — the
//!    HIGH-volume hot path. Encoded BINARY (id-len + id + seq + raw bytes), never
//!    JSON/base64, mirroring the in-app `ipc::Channel` Raw discipline (§9 trap g) so
//!    the daemon's output bridges onto the same `InvokeResponseBody::Raw` sink the
//!    shipped web already consumes.
//!
//! Every frame is `[kind:u8][len:u32 BE][payload:len]`. `read_frame` tolerates a
//! partial read (it loops to fill the header + body) and returns `Ok(None)` on a
//! clean EOF, so a disconnected peer ends the read loop instead of erroring.
//!
//! **Version negotiation:** the client opens with [`ClientMessage::Hello`] carrying
//! [`PROTOCOL_VERSION`]; the daemon replies [`ServerMessage::HelloAck`] with ITS
//! version + the live session list. On an unbridgeable mismatch the app treats the
//! daemon as unavailable and falls back to the shipped read-only restore (§5.4) —
//! it never guesses a foreign wire shape.

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

use crate::terminal::TerminalSessionInfo;

/// The wire-protocol version. Bumped on any breaking change to the message shapes
/// below. A client and daemon that disagree and can't bridge fall back to read-only
/// restore rather than corrupt a live session (§5.4 version-skew row).
pub(crate) const PROTOCOL_VERSION: u32 = 1;

/// Frame-kind discriminator byte for a control (JSON) frame.
const FRAME_CONTROL: u8 = 0x01;
/// Frame-kind discriminator byte for an output (binary) frame.
const FRAME_OUTPUT: u8 = 0x02;

/// Hard ceiling on a single frame's payload so a corrupt/hostile length prefix
/// can't make a peer allocate unboundedly. Output batches are coalesced (≤ a few
/// KB) and control messages are tiny; 16 MiB is comfortably above any legitimate
/// frame while bounding a bad actor.
const MAX_FRAME_LEN: u32 = 16 * 1024 * 1024;

/// A command the app-side client sends to the daemon. `bytes` on [`Write`](Self::Write)
/// is a small keystroke/paste payload — a JSON number array, exactly like the shipped
/// `terminal_write` command carries `Vec<u8>` — never the hot output path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub(crate) enum ClientMessage {
    /// Open the connection + negotiate. Always the first message.
    Hello { version: u32 },
    /// Spawn a new (UNCONFINED — confined sessions are daemon-exempt, §5.5) shell.
    Create { cwd: String, cols: u16, rows: u16 },
    /// Forward user input to a session's shell.
    Write { id: String, bytes: Vec<u8> },
    /// Resize a session's pty (SIGWINCH).
    Resize { id: String, cols: u16, rows: u16 },
    /// Set (or clear, with `None`) a session's manual tab title.
    SetTitle { id: String, title: Option<String> },
    /// Terminate a session (idempotent).
    Kill { id: String },
    /// List the daemon's live sessions.
    List,
    /// Begin streaming a session's output: the daemon replays its buffered tail with
    /// `seq > since_seq`, then streams live output frames. `since_seq = 0` replays the
    /// whole retained ring (the relaunch/reattach case — a fresh xterm, §5.3).
    Subscribe { id: String, since_seq: u64 },
    /// Liveness probe (stale-socket detection on connect).
    Ping,
}

/// A response/notification the daemon sends the client. Output does NOT ride here —
/// it is a binary [`FRAME_OUTPUT`] frame ([`OutputFrame`]); these are the JSON
/// control replies only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub(crate) enum ServerMessage {
    /// Reply to [`ClientMessage::Hello`]: the daemon's protocol version + its live
    /// sessions (so the app can reattach/reconcile immediately).
    HelloAck {
        version: u32,
        sessions: Vec<TerminalSessionInfo>,
    },
    /// A session was created.
    Created { info: TerminalSessionInfo },
    /// The live session list.
    Sessions { sessions: Vec<TerminalSessionInfo> },
    /// A command succeeded with no payload (write/resize/kill/set-title/subscribe).
    Ok,
    /// A command failed; `message` is the human-readable reason.
    Error { message: String },
    /// Reply to [`ClientMessage::Ping`].
    Pong,
}

/// A binary output frame: a session's coalesced raw PTY bytes tagged with a
/// monotonic sequence number for replay dedupe (§5.3). Encoded WITHOUT JSON/base64.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct OutputFrame {
    pub(crate) id: String,
    pub(crate) seq: u64,
    pub(crate) bytes: Vec<u8>,
}

/// A frame read off the wire — either a decoded control message or a raw output
/// frame. Kept an enum so one `read_frame` drives both the client and daemon loops.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Frame {
    Control(Vec<u8>),
    Output(OutputFrame),
}

/// Serialize + frame a [`ClientMessage`] onto `w`.
pub(crate) fn write_client(w: &mut impl Write, msg: &ClientMessage) -> io::Result<()> {
    let payload = serde_json::to_vec(msg).map_err(io::Error::other)?;
    write_frame(w, FRAME_CONTROL, &payload)
}

/// Serialize + frame a [`ServerMessage`] onto `w`.
pub(crate) fn write_server(w: &mut impl Write, msg: &ServerMessage) -> io::Result<()> {
    let payload = serde_json::to_vec(msg).map_err(io::Error::other)?;
    write_frame(w, FRAME_CONTROL, &payload)
}

/// Frame + write an output batch (the hot path). The payload is
/// `[id_len:u32 BE][id][seq:u64 BE][bytes]` — raw, no base64.
pub(crate) fn write_output(w: &mut impl Write, id: &str, seq: u64, bytes: &[u8]) -> io::Result<()> {
    let id_bytes = id.as_bytes();
    let mut payload = Vec::with_capacity(4 + id_bytes.len() + 8 + bytes.len());
    payload.extend_from_slice(&(id_bytes.len() as u32).to_be_bytes());
    payload.extend_from_slice(id_bytes);
    payload.extend_from_slice(&seq.to_be_bytes());
    payload.extend_from_slice(bytes);
    write_frame(w, FRAME_OUTPUT, &payload)
}

fn write_frame(w: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    if payload.len() as u64 > MAX_FRAME_LEN as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame exceeds the maximum length",
        ));
    }
    let mut header = [0u8; 5];
    header[0] = kind;
    header[1..].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    w.write_all(&header)?;
    w.write_all(payload)?;
    w.flush()
}

/// Read one frame, blocking until it is complete. Returns `Ok(None)` on a clean EOF
/// at a frame boundary (the peer closed the connection) so a read loop ends cleanly.
/// A truncated frame (EOF mid-frame) or an over-length prefix is an error.
pub(crate) fn read_frame(r: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut header = [0u8; 5];
    if !read_exact_or_eof(r, &mut header)? {
        return Ok(None);
    }
    let kind = header[0];
    let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]);
    if len > MAX_FRAME_LEN {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame length prefix exceeds the maximum",
        ));
    }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload)?;
    match kind {
        FRAME_CONTROL => Ok(Some(Frame::Control(payload))),
        FRAME_OUTPUT => Ok(Some(Frame::Output(decode_output(&payload)?))),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unknown frame kind {other:#x}"),
        )),
    }
}

/// Decode a control-frame payload into a [`ClientMessage`] (daemon side).
pub(crate) fn decode_client(payload: &[u8]) -> io::Result<ClientMessage> {
    serde_json::from_slice(payload).map_err(io::Error::other)
}

/// Decode a control-frame payload into a [`ServerMessage`] (client side).
pub(crate) fn decode_server(payload: &[u8]) -> io::Result<ServerMessage> {
    serde_json::from_slice(payload).map_err(io::Error::other)
}

fn decode_output(payload: &[u8]) -> io::Result<OutputFrame> {
    if payload.len() < 4 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "output frame shorter than its id-length prefix",
        ));
    }
    let id_len = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
    let rest = &payload[4..];
    if rest.len() < id_len + 8 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "output frame shorter than its declared id + seq",
        ));
    }
    let id = String::from_utf8(rest[..id_len].to_vec())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "output frame id is not utf8"))?;
    let seq_bytes: [u8; 8] = rest[id_len..id_len + 8].try_into().expect("bounds checked");
    let seq = u64::from_be_bytes(seq_bytes);
    let bytes = rest[id_len + 8..].to_vec();
    Ok(OutputFrame { id, seq, bytes })
}

/// Fill `buf` completely; `Ok(false)` if EOF hits before ANY byte is read (a clean
/// close at a frame boundary), `Ok(true)` on a full read. EOF after a partial read
/// is a truncated-frame error.
fn read_exact_or_eof(r: &mut impl Read, buf: &mut [u8]) -> io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => {
                if filled == 0 {
                    return Ok(false);
                }
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "connection closed mid-frame",
                ));
            }
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn info(id: &str) -> TerminalSessionInfo {
        TerminalSessionInfo {
            id: id.to_string(),
            cwd: "/work".to_string(),
            shell: "/bin/zsh".to_string(),
            confined: false,
            cols: 80,
            rows: 24,
            alive: true,
            created_at: 42,
            title: Some("deploy".to_string()),
        }
    }

    #[test]
    fn client_message_round_trips_through_a_frame() {
        let mut buf = Vec::new();
        let msg = ClientMessage::Create {
            cwd: "/work".to_string(),
            cols: 120,
            rows: 40,
        };
        write_client(&mut buf, &msg).unwrap();
        let mut cur = Cursor::new(buf);
        match read_frame(&mut cur).unwrap().unwrap() {
            Frame::Control(payload) => assert_eq!(decode_client(&payload).unwrap(), msg),
            other => panic!("expected control frame, got {other:?}"),
        }
    }

    #[test]
    fn server_hello_ack_carries_sessions() {
        let mut buf = Vec::new();
        let msg = ServerMessage::HelloAck {
            version: PROTOCOL_VERSION,
            sessions: vec![info("a"), info("b")],
        };
        write_server(&mut buf, &msg).unwrap();
        let mut cur = Cursor::new(buf);
        match read_frame(&mut cur).unwrap().unwrap() {
            Frame::Control(payload) => assert_eq!(decode_server(&payload).unwrap(), msg),
            other => panic!("expected control frame, got {other:?}"),
        }
    }

    #[test]
    fn output_frame_preserves_raw_bytes_and_seq() {
        // Escape sequences and NULs must survive the binary hot path verbatim.
        let raw = b"\x1b[32mgreen\x1b[0m\x00\xff\n";
        let mut buf = Vec::new();
        write_output(&mut buf, "sess-1", 987, raw).unwrap();
        let mut cur = Cursor::new(buf);
        match read_frame(&mut cur).unwrap().unwrap() {
            Frame::Output(frame) => {
                assert_eq!(frame.id, "sess-1");
                assert_eq!(frame.seq, 987);
                assert_eq!(frame.bytes, raw);
            }
            other => panic!("expected output frame, got {other:?}"),
        }
    }

    #[test]
    fn multiple_frames_stream_back_to_back() {
        let mut buf = Vec::new();
        write_client(&mut buf, &ClientMessage::Ping).unwrap();
        write_output(&mut buf, "x", 1, b"hi").unwrap();
        write_client(&mut buf, &ClientMessage::List).unwrap();
        let mut cur = Cursor::new(buf);
        assert!(matches!(
            read_frame(&mut cur).unwrap(),
            Some(Frame::Control(_))
        ));
        assert!(matches!(
            read_frame(&mut cur).unwrap(),
            Some(Frame::Output(_))
        ));
        assert!(matches!(
            read_frame(&mut cur).unwrap(),
            Some(Frame::Control(_))
        ));
        // A clean EOF at the boundary ends the stream.
        assert_eq!(read_frame(&mut cur).unwrap(), None);
    }

    #[test]
    fn empty_reader_is_a_clean_eof() {
        let mut cur = Cursor::new(Vec::new());
        assert_eq!(read_frame(&mut cur).unwrap(), None);
    }

    #[test]
    fn a_truncated_frame_errors_rather_than_eofs() {
        // Header says 10 bytes but only 3 follow → truncated, not a clean close.
        let mut buf = Vec::new();
        buf.push(FRAME_CONTROL);
        buf.extend_from_slice(&10u32.to_be_bytes());
        buf.extend_from_slice(b"abc");
        let mut cur = Cursor::new(buf);
        assert!(read_frame(&mut cur).is_err());
    }

    #[test]
    fn an_over_length_prefix_is_rejected() {
        let mut buf = Vec::new();
        buf.push(FRAME_CONTROL);
        buf.extend_from_slice(&(MAX_FRAME_LEN + 1).to_be_bytes());
        let mut cur = Cursor::new(buf);
        assert!(read_frame(&mut cur).is_err());
    }

    #[test]
    fn a_version_mismatch_is_observable_on_the_ack() {
        // The negotiation contract: the client can read the daemon's version off the
        // ack and decide to fall back — the wire carries it explicitly.
        let mut buf = Vec::new();
        write_server(
            &mut buf,
            &ServerMessage::HelloAck {
                version: 999,
                sessions: vec![],
            },
        )
        .unwrap();
        let mut cur = Cursor::new(buf);
        let Frame::Control(payload) = read_frame(&mut cur).unwrap().unwrap() else {
            panic!("expected control");
        };
        match decode_server(&payload).unwrap() {
            ServerMessage::HelloAck { version, .. } => assert_eq!(version, 999),
            other => panic!("expected hello-ack, got {other:?}"),
        }
    }
}
