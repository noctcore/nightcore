//! The persistent provider sidecar reader and the run/cancel commands.
//!
//! Protocol (line-delimited JSON over the child's stdio):
//!   - we WRITE one `SurfaceCommand` JSON object per line to the sidecar's stdin
//!   - we READ one `NightcoreEvent` JSON object per line from its stdout
//!   - the sidecar's stderr is human logs; we CAPTURE it (provider.rs pipes it)
//!     and re-emit each line through the Rust `tracing` sink under target `sidecar`
//!
//! M2 generalizes M1's single-task serial path to N concurrent sessions through
//! ONE persistent sidecar (the engine's `SessionManager` already multiplexes
//! sessions). The change from M1: the reader correlates each event to a task via
//! the provider's `sessionId → taskId` map (M1 tagged everything with the single
//! `active_task`). Concurrency is bounded by the [`SlotManager`]; a run holds a
//! slot from lease until its terminal event releases it.
//!
//! `run_task` stays as the manual single-run path (useful even with the loop):
//! it leases a slot, allocates a worktree, and dispatches — exactly what the
//! coordinator's `launch` does, just triggered by a click instead of a tick.

mod commands;
mod convert;
mod harness;
mod insight;
mod permission;
mod pr_review;
mod provider_config;
mod reader;
mod scan;
mod scorecard;
mod sessions;
mod verification;

// Module facade: preserve the historical `crate::sidecar::*` paths after the
// god-file split so call sites elsewhere keep resolving unchanged. The command
// re-export is a glob so the `#[tauri::command]` macro's generated siblings
// (`__cmd__*`, `__tauri_command_name_*`) reach `sidecar::*` for `generate_handler!`.
pub(crate) use commands::*;
// The session-history/resume commands (glob so the macro siblings resolve through
// `sidecar::*` for `generate_handler!`, like `commands::*`).
pub(crate) use sessions::*;
// The read-only provider-config inspector command (glob so the `#[tauri::command]`
// macro siblings resolve through `sidecar::*` for `generate_handler!`).
pub(crate) use provider_config::*;
// The Insight (codebase analysis) commands + the reader-side `analysis-*` handler
// (glob so the `#[tauri::command]` macro siblings resolve through `sidecar::*`).
pub(crate) use insight::*;
// The Harness (codebase convention auditor) commands + the reader-side `harness-*`
// handler (glob so the `#[tauri::command]` macro siblings resolve through `sidecar::*`).
pub(crate) use harness::*;
// The Readiness Scorecard (Profile) commands + the reader-side `scorecard-*` handler
// (glob so the `#[tauri::command]` macro siblings resolve through `sidecar::*`).
pub(crate) use scorecard::*;
// The PR Review commands + the reader-side `pr-review-*` handler (glob so the
// `#[tauri::command]` macro siblings resolve through `sidecar::*` for `generate_handler!`).
pub(crate) use pr_review::*;
pub(crate) use verification::dispatch_reviewer_for;
// The PR-comment fix-build dispatcher (PR arc, phase 3): `workflow::pr_comments`
// reaches it as `crate::sidecar::dispatch_pr_comment_fix`, a peer of the reviewer.
pub(crate) use verification::dispatch_pr_comment_fix;
// The untrusted-content fence (`scan` is a private module): re-exported so the PR
// review-comment prompt in `workflow::pr_comments` can wrap UNTRUSTED GitHub
// comment bodies as `crate::sidecar::untrusted_block`.
pub(crate) use scan::untrusted_block;
// Re-exported only to keep the `crate::sidecar::MAX_FIX_ATTEMPTS` intra-doc link
// in `task.rs` resolving; no code outside `verification` reads it through here.
#[allow(unused_imports)]
pub(crate) use verification::MAX_FIX_ATTEMPTS;

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::contracts::SurfaceQuery;
use crate::engine_api::EngineApi;
use crate::provider::{parse_line, Provider, SidecarProvider};
use crate::store::TaskStore;
use crate::task::{Task, TaskStatus, TASK_EVENT};

use reader::handle_event;

/// The Tauri event carrying one streamed sidecar event for a task.
/// Payload: `{ taskId: string, event: NightcoreEvent }`.
pub(crate) const SESSION_EVENT: &str = "nc:session";

/// The Tauri event carrying an interactive permission prompt for a task. Payload:
/// `{ taskId, requestId, toolName, input, suggestions? }`. The webview renders the
/// prompt and answers via the `respond_permission` command. Permission inputs may
/// contain paths/commands — they are surfaced to the UI but NEVER logged.
pub(crate) const PERMISSION_EVENT: &str = "nc:permission";

/// The Tauri event carrying an interactive `AskUserQuestion` prompt for a task.
/// Payload: `{ taskId, requestId, toolUseId?, questions }`. The webview renders the
/// question picker and answers via the `answer_question` command. Question prompts
/// carry the model's question/option text — surfaced to the UI but NEVER logged.
pub(crate) const QUESTION_EVENT: &str = "nc:question";

/// The Tauri event carrying one streamed Insight `analysis-*` event. Unlike
/// `nc:session`, the payload is the raw `NightcoreEvent` (it already carries its
/// own `runId`); the Insight view folds the stream and reconciles against the
/// persisted run on completion.
pub(crate) const INSIGHT_EVENT: &str = "nc:insight";

/// The Tauri event carrying one streamed Harness `harness-*` event. Like
/// `nc:insight`, the payload is the raw `NightcoreEvent` (it carries its own
/// `runId`); the Harness view folds the stream and reconciles against the persisted
/// run on completion. `apply_harness_artifact` also emits an `artifact-applied`
/// notice on this channel.
pub(crate) const HARNESS_EVENT: &str = "nc:harness";

/// The Tauri event carrying one streamed Scorecard `scorecard-*` event. Like
/// `nc:insight`, the payload is the raw `NightcoreEvent` (it carries its own
/// `runId`); the Scorecard view folds the stream and reconciles against the
/// persisted run on completion. `convert_reading_to_task` also emits a
/// `reading-converted` notice on this channel.
pub(crate) const SCORECARD_EVENT: &str = "nc:scorecard";

/// The Tauri event carrying one streamed PR Review `pr-review-*` event. Like
/// `nc:insight`, the payload is the raw `NightcoreEvent` (it carries its own `runId`);
/// the PR Review view folds the stream and reconciles against the persisted run on
/// completion. `convert_review_finding_to_task` also emits a `pr-review-finding-converted`
/// notice on this channel.
pub(crate) const PRREVIEW_EVENT: &str = "nc:pr-review";

/// The Tauri event carrying one pr-fix state snapshot (`PrFixState`, the
/// address-review-findings runner in [`crate::workflow::pr_fix`]). Unlike the
/// scan channels this carries the FULL state on every change (registered /
/// committed-awaiting-push / pushed / failed), not a raw engine event — the web
/// reconciles via `list_pr_fixes` and folds these snapshots.
pub(crate) const PRFIX_EVENT: &str = "nc:pr-fix";

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
    if orphaned.is_empty() {
        tracing::warn!(target: "nightcore", "sidecar exited with no in-flight runs to recover");
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

/// How a run ended, for terminal bookkeeping.
pub(crate) enum Outcome {
    /// `session-completed`: clean up the worktree (per policy), reset the breaker.
    Succeeded,
    /// `session-failed` (genuine): retain the worktree, feed the breaker. `fatal`
    /// carries the structured error taxonomy's verdict — an `auth`/`disk-full`
    /// category (a broken-setup cause) trips the breaker AT ONCE rather than
    /// accumulating toward the sliding-window threshold, so the auto-loop stops
    /// instead of burning more tasks that fail identically.
    Failed { fatal: bool },
    /// `session-failed { reason: "aborted" }` (cancel / circuit-break): retain the
    /// worktree, but do NOT count toward the breaker.
    Aborted,
    /// M4: a verification gate terminal that parks the task for human approval
    /// (FAIL / auto-fix budget exhausted / inconclusive). Releases the slot and
    /// forgets the session, but RETAINS the worktree for inspection and does NOT
    /// feed the breaker (a CHANGES_REQUESTED the agent couldn't fix, or a review
    /// crash, is not a broken build setup). See [`park_for_approval`].
    #[allow(dead_code)]
    NeedsApproval,
}

/// A verification gate terminal (M4 §B "holding"): release the slot, forget the
/// session, RETAIN the worktree (the user will inspect/approve it), do NOT feed
/// the breaker, then kick the coordinator. Distinct from [`finish_run`], which
/// would clean the worktree and touch the breaker.
pub(crate) fn park_for_approval(app: &AppHandle, task_id: &str, session_id: Option<u64>) {
    let provider = app.state::<Arc<SidecarProvider>>();
    let engine = app.state::<Arc<dyn EngineApi>>();
    engine.slots_release(app, task_id);
    let _ = engine.permissions_drain_task(app, task_id);
    if let Some(sid) = session_id {
        provider.forget(sid);
    }
    // Worktree is intentionally retained; the breaker is intentionally untouched.
    engine.kick(app);
}

/// A run reached a terminal state: release its slot, drop the correlation binding,
/// clean up the worktree (per policy), feed the circuit breaker, and kick the
/// coordinator so the board drains without waiting a full interval.
/// Fire a desktop notification for a terminal task outcome, gated on the global
/// `notify_on_complete` setting (M3 §C). Only the two terminal outcomes the user
/// asked to be told about — `Done` and `Failed` — notify; aborts (user-cancelled)
/// and approval parks do not. The body carries only the task title + outcome —
/// never a token, secret, or summary (M4.5 logging discipline). Best-effort: a
/// failed notification is logged at debug, never surfaced.
pub(crate) fn notify_task_complete(app: &AppHandle, task_id: &str, succeeded: bool) {
    use crate::settings::SettingsStore;
    if !app
        .state::<SettingsStore>()
        .with_settings(|s| s.notify_on_complete)
    {
        return;
    }
    let Some(task) = app.state::<TaskStore>().get(task_id) else {
        return;
    };
    let outcome = if succeeded { "completed" } else { "failed" };
    let title = format!("Task {outcome}");
    let body = task.title;

    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::debug!(target: "nightcore", task_id, error = %e, "desktop notification failed");
    }
}

pub(crate) fn finish_run(
    app: &AppHandle,
    task_id: &str,
    session_id: Option<u64>,
    outcome: Outcome,
) {
    let provider = app.state::<Arc<SidecarProvider>>();
    let engine = app.state::<Arc<dyn EngineApi>>();
    engine.slots_release(app, task_id);
    // Any permission request still parked for this run is moot: the session has
    // reached a terminal state and the engine's own teardown denies its SDK control
    // request. Drop our registry entries so they can't leak across reruns.
    let _ = engine.permissions_drain_task(app, task_id);
    if let Some(sid) = session_id {
        provider.forget(sid);
    }
    // Worktree cleanup is deliberately NOT done here. A finished task — even a
    // verified/Done one — keeps its worktree so the user can still review, merge, or
    // discard it. The worktree is removed only when the user merges the branch
    // (`workflow::merge`, which honors `cleanupWorktrees` and also deletes the
    // `nc/<id>` branch) or explicitly discards it. Removing it on the terminal event
    // tore the worktree down before the user could merge — see the setting's own
    // copy ("after a task is merged") — leaving an orphaned branch.
    // M3 §C: tell the user a task reached a terminal state (Done/Failed only),
    // gated on `notify_on_complete`. Aborts/approval-parks don't notify.
    match outcome {
        Outcome::Succeeded => notify_task_complete(app, task_id, true),
        Outcome::Failed { .. } => notify_task_complete(app, task_id, false),
        Outcome::Aborted | Outcome::NeedsApproval => {}
    }
    match outcome {
        Outcome::Succeeded => engine.breaker_record_success(app),
        // Routed through `park_for_approval`, never here; handled for exhaustiveness.
        Outcome::Aborted | Outcome::NeedsApproval => {} // not a failure signal
        Outcome::Failed { fatal } => {
            // Category-based branch: a fatal-setup failure (auth/disk-full) trips the
            // breaker at once; a transient one accumulates toward the tolerant window.
            let tripped = if fatal {
                engine.breaker_record_fatal(app)
            } else {
                engine.breaker_record_failure(app)
            };
            if tripped {
                // This failure tripped the breaker: interrupt the rest and pause.
                let cause = if fatal {
                    "circuit-breaker-fatal"
                } else {
                    "circuit-breaker"
                };
                tracing::warn!(target: "nightcore", task_id, fatal, threshold = engine.breaker_threshold(app), "circuit breaker tripped; pausing auto-loop");
                engine.emit_state(app, "paused", Some(cause));
                let app = app.clone();
                // `tauri::async_runtime::spawn` (not bare `tokio::spawn`) — the latter
                // panics when no Tokio runtime is entered on the calling thread and
                // aborted the release app via SIGABRT across the WKWebView extern-"C"
                // boundary. `finish_run` is a `pub(crate)` terminal-transition helper;
                // a refactor reaching this breaker branch from a sync Tauri
                // command/callback thread would otherwise reintroduce the abort. Mirrors
                // the guarded sibling sites (fail_run in submit.rs, auto_loop start/stop)
                // and is guarded by the source-grep regression test below.
                tauri::async_runtime::spawn(async move {
                    app.state::<Arc<dyn EngineApi>>().interrupt_all(&app).await;
                });
            }
        }
    }
    engine.kick(app);
}

/// Mutate a task, persist, and emit `nc:task`.
pub(crate) fn apply_and_emit<F>(app: &AppHandle, store: &TaskStore, id: &str, f: F)
where
    F: FnOnce(&mut Task),
{
    match store.mutate(id, f) {
        Ok(task) => {
            // The store mutation already landed; if the emit fails the board never
            // learns the (often terminal Done/Failed) transition and the row stays
            // visually wedged until an unrelated later event repaints it. Rare, but
            // make the desync observable instead of swallowing it silently.
            if let Err(e) = app.emit(TASK_EVENT, &task) {
                tracing::warn!(target: "nightcore", task_id = id, error = %e, "failed to emit nc:task after mutation");
            }
        }
        Err(e) => {
            tracing::error!(target: "nightcore", task_id = id, error = %e, "failed to finalize task")
        }
    }
}

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

    #[test]
    fn finish_run_breaker_trip_uses_the_guarded_spawn() {
        // Regression guard for the SIGABRT pattern (nightcore-2026-06-27-161645.ips):
        // the breaker-trip branch of `finish_run` must launch `interrupt_all` via
        // `tauri::async_runtime::spawn`, never bare `tokio::spawn` (which panics when no
        // Tokio runtime is entered on the calling thread and aborted the release app
        // across the WKWebView extern-"C" boundary). The spawn site needs a full
        // `AppHandle`, so this is a source-level guard rather than a behavioral one.
        // Unlike submit.rs, this file has legitimate on-runtime bare `tokio::spawn`s
        // (the sidecar stdout/stderr readers), so the guard is scoped to the window of
        // source immediately preceding the `interrupt_all` spawn body rather than a
        // blanket file-wide grep. Mirrors submit.rs's
        // `fail_run_breaker_trip_uses_the_guarded_spawn`.
        let src = include_str!("mod.rs");
        let needle = ".interrupt_all(&app).await;";
        let at = src
            .find(needle)
            .expect("finish_run's interrupt_all spawn body must exist");
        // The `spawn(...)` opener sits on the line just above the interrupt_all call.
        let window = &src[at.saturating_sub(160)..at];
        let bare_spawn = concat!("tokio", "::spawn(async move {");
        assert!(
            !window.contains(bare_spawn),
            "finish_run must NOT use bare tokio::spawn — it aborts off-runtime (SIGABRT)"
        );
        assert!(
            window.contains("tauri::async_runtime::spawn(async move {"),
            "finish_run must launch interrupt_all via the guarded tauri::async_runtime::spawn"
        );
    }
}
