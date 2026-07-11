//! The sidecar NDJSON transport (issue #37): spawn + stdout/stderr readers, the
//! length-capped line reader, the query round-trip, and crash recovery.
//!
//! Split out of `sidecar/mod.rs` so the wire layer (how bytes become events and
//! what happens when the child dies) is separate from the run-lifecycle
//! bookkeeping in [`super::lifecycle`]. The historical `crate::sidecar::*` paths
//! are preserved by the facade re-export in `sidecar/mod.rs`.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::contracts::SurfaceQuery;
use crate::engine_api::EngineApi;
use crate::provider::{parse_line, Provider, SidecarProvider};
use crate::store::TaskStore;
use crate::task::{TaskStatus, TASK_EVENT};

use super::reader::handle_event;

/// The maximum byte length of a single NDJSON line accepted from the sidecar's
/// stdout. Legitimate events (lifecycle, deltas, even large tool-result content)
/// sit far below this; the bound exists only to stop a newline-free multi-GB
/// emission from OOM-ing the core. A line over the cap is dropped whole and the
/// reader resynchronizes at the next newline (see [`read_capped_line`]).
const MAX_WIRE_LINE_BYTES: usize = 16 * 1024 * 1024;

/// One outcome of [`read_capped_line`]. `Line` is a complete newline-terminated
/// (or final EOF-terminated) line within the cap; `Oversized` reports the byte
/// count of a line that exceeded the cap and was dropped; `Eof` is a clean stream
/// close; `Err` is a read error.
enum WireLine {
    Line(String),
    Oversized(usize),
    Eof,
    Err(std::io::Error),
}

/// Read one line from `reader`, bounding the in-memory accumulation to `max_bytes`.
/// Unlike `AsyncBufReadExt::next_line`, a line whose bytes exceed `max_bytes` is NOT
/// buffered whole: once the accumulator would pass the cap we discard it and skip
/// bytes until the terminating newline, returning [`WireLine::Oversized`] with the
/// total bytes seen so the caller can log and continue. A trailing `\r` is stripped
/// (CRLF), matching `next_line`. Invalid UTF-8 is decoded lossily (the JSON parser
/// downstream rejects it as a normal parse error).
async fn read_capped_line<R>(reader: &mut R, max_bytes: usize) -> WireLine
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    let mut buf: Vec<u8> = Vec::new();
    let mut overflowed = false;
    let mut discarded: usize = 0;
    loop {
        let available = match reader.fill_buf().await {
            Ok(b) => b,
            Err(e) => return WireLine::Err(e),
        };
        if available.is_empty() {
            // EOF: emit whatever complete-but-unterminated content we hold.
            if overflowed {
                return WireLine::Oversized(discarded);
            }
            if buf.is_empty() {
                return WireLine::Eof;
            }
            return WireLine::Line(finalize_line(&buf));
        }
        match available.iter().position(|&b| b == b'\n') {
            Some(pos) => {
                if !overflowed {
                    let remaining = max_bytes.saturating_sub(buf.len());
                    if pos > remaining {
                        overflowed = true;
                        discarded = buf.len() + pos;
                    } else {
                        buf.extend_from_slice(&available[..pos]);
                    }
                }
                reader.consume(pos + 1);
                if overflowed {
                    return WireLine::Oversized(discarded);
                }
                return WireLine::Line(finalize_line(&buf));
            }
            None => {
                let len = available.len();
                if !overflowed {
                    let remaining = max_bytes.saturating_sub(buf.len());
                    if len > remaining {
                        // This chunk pushes us past the cap with no newline in
                        // sight — abandon the accumulator and start discarding.
                        overflowed = true;
                        discarded = buf.len() + len;
                        buf = Vec::new();
                    } else {
                        buf.extend_from_slice(available);
                    }
                } else {
                    discarded = discarded.saturating_add(len);
                }
                reader.consume(len);
            }
        }
    }
}

/// Decode an accumulated line to a `String` (lossy) and strip a trailing `\r` so a
/// Windows CRLF terminator doesn't leak into the JSON parse (parity with
/// `AsyncBufReadExt::next_line`).
fn finalize_line(buf: &[u8]) -> String {
    let mut s = String::from_utf8_lossy(buf).into_owned();
    if s.ends_with('\r') {
        s.pop();
    }
    s
}

/// Ensure the persistent sidecar is running and its stdout reader is installed.
/// Idempotent: spawns lazily on first use, then a no-op. Shared by `run_task` and
/// the coordinator's `launch`.
pub async fn ensure_reader(app: &AppHandle) -> Result<(), String> {
    let provider = app.state::<Arc<SidecarProvider>>();
    tracing::info!(target: "nightcore", "ensuring sidecar is up");
    let Some(streams) = provider.spawn().await? else {
        return Ok(()); // already running
    };
    tracing::info!(target: "sidecar", "sidecar spawned (bun)");
    let crate::provider::SidecarStreams { stdout, stderr } = streams;

    // The reader outlives every individual run: it streams the single persistent
    // sidecar's stdout for the whole app lifetime, correlating each event to its
    // task and applying terminal transitions + slot release + worktree cleanup.
    let reader_app = app.clone();
    tokio::spawn(async move {
        // A length-bounded line reader (NOT `.lines()`): tokio's `next_line`
        // accumulates bytes until a newline with NO maximum, so one newline-free
        // multi-GB emission from a compromised/runaway sidecar would be buffered
        // whole into a String (then copied again by serde) and OOM the core. We cap
        // each line and DROP anything over the cap, resynchronizing at the next
        // newline — the wire is only structurally trusted, so a dropped line is an
        // availability event, never a correctness one.
        let mut reader = BufReader::new(stdout);
        loop {
            match read_capped_line(&mut reader, MAX_WIRE_LINE_BYTES).await {
                WireLine::Line(raw) => match parse_line(&raw) {
                    Some(Ok(event)) => handle_event(&reader_app, event).await,
                    // A protocol parse error: the bad line is debug-only (it may
                    // echo content), the failure itself is a warn.
                    Some(Err(e)) => {
                        tracing::warn!(target: "sidecar", error = %e, "sidecar protocol parse error")
                    }
                    None => {}
                },
                WireLine::Oversized(bytes) => {
                    tracing::error!(target: "sidecar", bytes, cap = MAX_WIRE_LINE_BYTES, "dropped oversized sidecar line (exceeds wire cap) — resynchronizing");
                }
                WireLine::Eof => {
                    tracing::warn!(target: "sidecar", "sidecar stdout closed (process exited)");
                    handle_sidecar_crash(&reader_app).await;
                    break;
                }
                WireLine::Err(e) => {
                    tracing::error!(target: "sidecar", error = %e, "error reading sidecar stdout");
                    handle_sidecar_crash(&reader_app).await;
                    break;
                }
            }
        }
    });

    // Drain the sidecar's stderr (now piped, M4.5 §B4): re-emit each leveled line
    // through the Rust `tracing` sink under target `sidecar` so it lands in the same
    // colored console + rolling file. stdout stays the pure NDJSON protocol.
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(raw)) = lines.next_line().await {
            if raw.trim().is_empty() {
                continue;
            }
            emit_sidecar_line(&raw);
        }
    });

    Ok(())
}

/// Issue a [`SurfaceQuery`] over the sidecar, ensuring the child is spawned and its
/// stdout reader is installed first. All query-based Tauri commands must route
/// through here rather than calling [`Provider::query`] directly — the sidecar is
/// lazily started on first use (a task run or this helper), never at app boot.
pub async fn query(app: &AppHandle, query: SurfaceQuery) -> Result<Value, String> {
    ensure_reader(app).await?;
    let provider = app.state::<Arc<SidecarProvider>>();
    provider.query(query).await
}

/// Re-emit one captured sidecar stderr line through the Rust `tracing` sink under
/// target `sidecar`. When the line carries our logger's leading `LEVEL` token (piped
/// mode — see the wire contract below) it maps to the matching tracing level and the
/// token is stripped, so the `tracing` fmt layer is the SOLE owner of the timestamp +
/// level + target. Lines without a known leading token (raw stderr, SDK/runtime
/// output) pass through verbatim at `Info`.
///
/// WIRE CONTRACT — keep in lockstep with the sidecar's `format()` in
/// packages/shared/src/logger.ts: in piped/captured mode the sidecar emits
/// `<LEVEL> [scope] <msg>` with the uppercase LEVEL token as field 0 and NO self
/// timestamp (Rust stamps the only one here). [`sidecar_level`] reads that field 0 and
/// [`strip_level_token`] removes it. If the sidecar moves the token without this parser
/// moving too, every captured line silently degrades to `Info`.
fn emit_sidecar_line(line: &str) {
    let rest = strip_level_token(line);
    match sidecar_level(line) {
        SidecarLevel::Error => tracing::error!(target: "sidecar", "{rest}"),
        SidecarLevel::Warn => tracing::warn!(target: "sidecar", "{rest}"),
        SidecarLevel::Info => tracing::info!(target: "sidecar", "{rest}"),
        SidecarLevel::Debug => tracing::debug!(target: "sidecar", "{rest}"),
    }
}

/// The level a captured sidecar line maps to. Defaults to `Info` when no known
/// token is present (an SDK/runtime line without our logger's shape).
enum SidecarLevel {
    Error,
    Warn,
    Info,
    Debug,
}

/// Whether `token` is one of the sidecar logger's uppercase `LEVEL` tokens.
fn is_level_token(token: &str) -> bool {
    matches!(token, "ERROR" | "WARN" | "INFO" | "DEBUG")
}

/// Parse the sidecar logger's leading `LEVEL` token (field 0 — in piped mode the
/// sidecar drops its self-timestamp, so the level is first). Unknown/absent ⇒ `Info`.
fn sidecar_level(line: &str) -> SidecarLevel {
    match line.split_whitespace().next().unwrap_or("") {
        "ERROR" => SidecarLevel::Error,
        "WARN" => SidecarLevel::Warn,
        "DEBUG" => SidecarLevel::Debug,
        _ => SidecarLevel::Info,
    }
}

/// Strip the leading `LEVEL` token (and following whitespace) from a captured sidecar
/// line, but ONLY when field 0 is one of our known level tokens — so the re-emitted
/// message no longer carries the wire-protocol level word (Rust stamps the level
/// instead). Lines without a known leading token (raw stderr, SDK output) are returned
/// unchanged so they still flow through intact at `Info`.
fn strip_level_token(line: &str) -> &str {
    let trimmed = line.trim_start();
    match trimmed.split_once(char::is_whitespace) {
        Some((token, rest)) if is_level_token(token) => rest.trim_start(),
        _ => line,
    }
}

/// Recover from a sidecar process exit (#11): the reader saw stdout close, so the
/// child is gone and every in-flight run is stranded (its terminal event will never
/// arrive). Reset provider state (drop the dead stdin handle so a re-spawn happens,
/// clear correlation) and, for each run that had a live session, drain its parked
/// permissions, release its slot, and requeue it to `Ready` so the auto-loop
/// re-dispatches it against a fresh sidecar instead of wedging on a dead session.
async fn handle_sidecar_crash(app: &AppHandle) {
    let provider = app.state::<Arc<SidecarProvider>>();
    let engine = app.state::<Arc<dyn EngineApi>>();
    let store = app.state::<TaskStore>();
    let orphaned = provider.reset_after_crash().await;
    // Reap in-flight SCAN runs too (T14): they correlate by `runId`, not `sessionId`,
    // so the task recovery below never touches them — a running scan would otherwise
    // stay `running` until the next boot. Independent of whether any TASK was orphaned,
    // so this runs before the no-tasks early return.
    super::reader::reap_scans_on_crash(app).await;
    if orphaned.is_empty() {
        tracing::warn!(target: "nightcore", "sidecar exited with no in-flight task runs to recover");
        return;
    }
    tracing::warn!(target: "nightcore", count = orphaned.len(), "sidecar exited; recovering stranded runs");
    for task_id in orphaned {
        // Drain any parked permission registry entries (the engine is dead; nothing
        // to deny on the wire) and free the slot the dead run held.
        let _ = engine.permissions_drain_task(app, &task_id);
        engine.slots_release(app, &task_id);
        // Requeue to Ready (mirrors boot reconciliation) so the loop re-dispatches.
        if let Ok(updated) = store.mutate(&task_id, |t| {
            t.status = TaskStatus::Ready;
            t.session_id = None;
            t.error = Some(match t.error.take() {
                Some(prev) if !prev.is_empty() => {
                    format!("{prev}\nSidecar exited mid-run — requeued.")
                }
                _ => "Sidecar exited mid-run — requeued.".to_string(),
            });
        }) {
            let _ = app.emit(TASK_EVENT, &updated);
        }
    }
    // Nudge the loop so it re-dispatches the requeued runs against a fresh sidecar.
    engine.kick(app);
}

#[cfg(test)]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_level_parses_the_leading_token() {
        // Piped-mode shape: the LEVEL token is field 0 (the sidecar drops its own
        // ISO timestamp when captured), so the parser reads field 0 — not field 1.
        assert!(matches!(
            sidecar_level("ERROR [sidecar:harness] boom"),
            SidecarLevel::Error
        ));
        assert!(matches!(
            sidecar_level("WARN [sidecar] careful"),
            SidecarLevel::Warn
        ));
        assert!(matches!(
            sidecar_level("INFO [sidecar:harness] [harness:design-decisions] turn 7 · Glob"),
            SidecarLevel::Info
        ));
        assert!(matches!(
            sidecar_level("DEBUG [sidecar] noisy"),
            SidecarLevel::Debug
        ));
    }

    #[test]
    fn unknown_or_raw_lines_default_to_info() {
        // Raw stderr (no logger LEVEL token at field 0) maps to Info.
        assert!(matches!(
            sidecar_level("nightcore-sidecar ready"),
            SidecarLevel::Info
        ));
        assert!(matches!(sidecar_level(""), SidecarLevel::Info));
    }

    #[test]
    fn strip_level_token_removes_only_a_known_leading_level() {
        // A logger line: the LEVEL token is consumed; the scope + message survive and
        // carry NO second timestamp (Rust's fmt layer adds the only one).
        let rest =
            strip_level_token("INFO [sidecar:harness] [harness:design-decisions] turn 7 · Glob");
        assert_eq!(
            rest,
            "[sidecar:harness] [harness:design-decisions] turn 7 · Glob"
        );
        assert!(!rest.contains("INFO"), "the level token is stripped");
        // No leading ISO-8601 timestamp remains in the re-emitted message.
        assert!(!rest.starts_with(|c: char| c.is_ascii_digit()));
    }

    #[test]
    fn strip_level_token_leaves_raw_lines_intact() {
        // No known LEVEL token at field 0 ⇒ pass through unchanged.
        assert_eq!(
            strip_level_token("nightcore-sidecar ready"),
            "nightcore-sidecar ready"
        );
    }

    #[tokio::test]
    async fn capped_line_reads_normal_lines_and_reports_eof() {
        use tokio::io::BufReader;
        let data = b"{\"a\":1}\n{\"b\":2}\n".to_vec();
        let mut reader = BufReader::new(&data[..]);
        let l1 = read_capped_line(&mut reader, 1024).await;
        assert!(matches!(l1, WireLine::Line(ref s) if s == "{\"a\":1}"));
        let l2 = read_capped_line(&mut reader, 1024).await;
        assert!(matches!(l2, WireLine::Line(ref s) if s == "{\"b\":2}"));
        assert!(matches!(
            read_capped_line(&mut reader, 1024).await,
            WireLine::Eof
        ));
    }

    #[tokio::test]
    async fn capped_line_drops_an_oversized_line_and_resynchronizes() {
        use tokio::io::BufReader;
        // A newline-free blob far larger than the cap, followed by a normal line.
        // The blob must be DROPPED (not buffered whole) and the next line must
        // parse cleanly — the resync that keeps one hostile emission from OOM-ing.
        let mut data = vec![b'x'; 5000];
        data.push(b'\n');
        data.extend_from_slice(b"{\"ok\":true}\n");
        let mut reader = BufReader::new(&data[..]);

        match read_capped_line(&mut reader, 256).await {
            WireLine::Oversized(bytes) => assert!(bytes >= 5000, "reports the byte count"),
            _ => panic!("expected Oversized for a line over the cap"),
        }
        let next = read_capped_line(&mut reader, 256).await;
        assert!(
            matches!(next, WireLine::Line(ref s) if s == "{\"ok\":true}"),
            "reader resynchronizes at the next newline"
        );
    }

    #[tokio::test]
    async fn capped_line_strips_trailing_carriage_return() {
        use tokio::io::BufReader;
        let data = b"{\"a\":1}\r\n".to_vec();
        let mut reader = BufReader::new(&data[..]);
        assert!(matches!(
            read_capped_line(&mut reader, 1024).await,
            WireLine::Line(ref s) if s == "{\"a\":1}"
        ));
    }
}
