//! The persistent Bun provider sidecar and the run/cancel commands.
//!
//! Protocol (line-delimited JSON over the child's stdio):
//!   - we WRITE one `SurfaceCommand` JSON object per line to the sidecar's stdin
//!   - we READ one `NightcoreEvent` JSON object per line from its stdout
//!   - the sidecar's stderr is human logs; we inherit it
//!
//! Unlike M0 (a fresh sidecar per prompt), M1 keeps ONE long-lived sidecar,
//! spawned lazily on the first `run_task` and kept alive in managed state. Its
//! `SessionManager` already multiplexes sessions, so M1 correlation is trivial:
//! execution is serial, so the single active task id tags every `nc:session`
//! event the reader forwards. On a terminal event (`session-completed` /
//! `session-failed`) the reader applies the status transition to that task.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::Mutex as AsyncMutex;

use crate::store::{workspace_root, TaskStore};
use crate::task::{Task, TaskStatus, TASK_EVENT};

/// The Tauri event carrying one streamed sidecar event for the active task.
/// Payload: `{ taskId: string, event: NightcoreEvent }`.
pub const SESSION_EVENT: &str = "nc:session";

/// Absolute path to the Bun sidecar entrypoint (dev: TS source in the workspace).
fn sidecar_entry() -> PathBuf {
    workspace_root().join("apps/sidecar/src/index.ts")
}

/// Long-lived sidecar handle in managed state. The stdin writer lives behind an
/// async mutex (commands are written from async command handlers); the active
/// task id behind a sync mutex (read/written from both the reader task and the
/// command handlers).
#[derive(Default)]
pub struct Sidecar {
    /// `Some` once the sidecar has been spawned. Holds the stdin writer.
    stdin: AsyncMutex<Option<ChildStdin>>,
    /// Id of the task whose run is currently streaming, if any.
    active_task: Mutex<Option<String>>,
}

impl Sidecar {
    /// Id of the task currently running, if any.
    pub fn active(&self) -> Option<String> {
        self.active_task.lock().expect("sidecar poisoned").clone()
    }

    fn set_active(&self, id: Option<String>) {
        *self.active_task.lock().expect("sidecar poisoned") = id;
    }
}

/// Write one `SurfaceCommand` as an NDJSON line to the sidecar's stdin.
async fn send_command(stdin: &mut ChildStdin, command: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(command).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("failed to write to sidecar: {e}"))?;
    stdin.flush().await.map_err(|e| e.to_string())
}

/// Ensure the persistent sidecar is running, spawning it lazily on first use.
/// On spawn, installs the stdout reader task. Holds the stdin lock for the call.
async fn ensure_started(app: &AppHandle, sidecar: &Sidecar) -> Result<(), String> {
    let mut guard = sidecar.stdin.lock().await;
    if guard.is_some() {
        return Ok(());
    }

    let mut child = Command::new("bun")
        .arg("run")
        .arg(sidecar_entry())
        .current_dir(workspace_root())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar (is `bun` on PATH?): {e}"))?;

    let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    *guard = Some(stdin);
    drop(guard);

    // The reader outlives every individual run: it streams the single persistent
    // sidecar's stdout for the whole app lifetime, tagging events with whichever
    // task is active and applying terminal transitions. The child handle is moved
    // in so it stays alive (and is reaped) with the reader.
    let app = app.clone();
    tokio::spawn(async move {
        let _child = child; // keep the process alive for the reader's lifetime
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(raw)) => {
                    let raw = raw.trim();
                    if raw.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(raw) {
                        Ok(event) => handle_event(&app, event).await,
                        Err(e) => eprintln!("sidecar emitted non-JSON line ({e}): {raw}"),
                    }
                }
                Ok(None) => break, // stdout closed: sidecar exited
                Err(e) => {
                    eprintln!("error reading sidecar stdout: {e}");
                    break;
                }
            }
        }
    });

    Ok(())
}

/// Process one parsed sidecar event: forward it as `nc:session` for the active
/// task, auto-deny permission requests, and apply terminal status transitions.
async fn handle_event(app: &AppHandle, event: Value) {
    let sidecar = app.state::<Sidecar>();
    let store = app.state::<TaskStore>();

    let Some(task_id) = sidecar.active() else {
        return; // no run in flight; nothing to correlate to (serial in M1)
    };

    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");

    // M1 auto-denies any permission request (same as M0). The sidecar also denies
    // internally, but we mirror M0's behaviour from the core for defence in depth.
    if event_type == "permission-required" {
        auto_deny(&app.state::<Sidecar>(), &event).await;
    }

    // Forward the raw event to the webview tagged with the active task.
    let _ = app.emit(
        SESSION_EVENT,
        serde_json::json!({ "taskId": task_id, "event": event }),
    );

    match event_type {
        // Capture the sidecar session id as soon as the session starts so
        // `cancel_task` has a live target to interrupt before the run ends.
        "session-started" | "session-ready" => {
            if let Some(session_id) = event.get("sessionId").and_then(Value::as_u64) {
                apply_and_emit(app, &store, &task_id, |task| {
                    task.session_id = Some(session_id);
                });
            }
        }
        "session-completed" => {
            apply_and_emit(app, &store, &task_id, |task| {
                task.status = TaskStatus::Done;
                task.summary = event
                    .get("result")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string());
                task.cost_usd = event.get("costUsd").and_then(Value::as_f64);
                task.session_id = event.get("sessionId").and_then(Value::as_u64);
                task.error = None;
            });
            sidecar.set_active(None);
        }
        "session-failed" => {
            apply_and_emit(app, &store, &task_id, |task| {
                task.status = TaskStatus::Failed;
                task.error = event
                    .get("message")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string());
                task.session_id = event.get("sessionId").and_then(Value::as_u64);
            });
            sidecar.set_active(None);
        }
        _ => {}
    }
}

/// Send an `approve-permission` deny back over stdin for a permission request.
async fn auto_deny(sidecar: &Sidecar, event: &Value) {
    let (Some(session_id), Some(request_id)) = (
        event.get("sessionId").and_then(Value::as_u64),
        event.get("requestId").and_then(Value::as_str),
    ) else {
        return;
    };
    let command = serde_json::json!({
        "type": "approve-permission",
        "sessionId": session_id,
        "requestId": request_id,
        "decision": {
            "behavior": "deny",
            "message": "M1 core: interactive approval not wired yet.",
        },
    });
    let mut guard = sidecar.stdin.lock().await;
    if let Some(stdin) = guard.as_mut() {
        let _ = send_command(stdin, &command).await;
    }
}

/// Mutate the active task to its terminal state, persist, and emit `nc:task`.
fn apply_and_emit<F>(app: &AppHandle, store: &TaskStore, id: &str, f: F)
where
    F: FnOnce(&mut Task),
{
    match store.mutate(id, f) {
        Ok(task) => {
            let _ = app.emit(TASK_EVENT, &task);
        }
        Err(e) => eprintln!("failed to finalize task {id}: {e}"),
    }
}

// --- Commands ---------------------------------------------------------------

/// Run a task through the sidecar. Serial in M1: errors if any task is already
/// `in_progress`. Sets the task `in_progress` (persist + `nc:task`), ensures the
/// sidecar is up, then sends `start-session`. Streaming and the terminal
/// transition happen on the reader task.
#[tauri::command]
pub async fn run_task(
    app: AppHandle,
    store: State<'_, TaskStore>,
    sidecar: State<'_, Sidecar>,
    id: String,
) -> Result<(), String> {
    if sidecar.active().is_some() {
        return Err("a task is already running".to_string());
    }

    let task = store
        .get(&id)
        .ok_or_else(|| format!("no task with id {id}"))?;

    // Claim the active slot before any await so two concurrent runs can't race
    // past the guard above.
    sidecar.set_active(Some(id.clone()));

    let updated = match store.mutate(&id, |task| {
        task.status = TaskStatus::InProgress;
        task.summary = None;
        task.error = None;
    }) {
        Ok(task) => task,
        Err(e) => {
            sidecar.set_active(None);
            return Err(e);
        }
    };
    let _ = app.emit(TASK_EVENT, &updated);

    if let Err(e) = ensure_started(&app, &sidecar).await {
        sidecar.set_active(None);
        return Err(e);
    }

    let command = serde_json::json!({
        "type": "start-session",
        "prompt": task.prompt(),
        "model": task.model,
    });

    let mut guard = sidecar.stdin.lock().await;
    let stdin = guard.as_mut().ok_or("sidecar stdin unavailable")?;
    if let Err(e) = send_command(stdin, &command).await {
        sidecar.set_active(None);
        return Err(e);
    }

    Ok(())
}

/// Best-effort interrupt of the current run. Sends an `interrupt` command for the
/// task's session if one is known; the terminal transition still arrives via the
/// sidecar's `session-failed` (`aborted`) event.
#[tauri::command]
pub async fn cancel_task(
    store: State<'_, TaskStore>,
    sidecar: State<'_, Sidecar>,
    id: String,
) -> Result<(), String> {
    let task = store
        .get(&id)
        .ok_or_else(|| format!("no task with id {id}"))?;

    let Some(session_id) = task.session_id else {
        return Ok(()); // no live session to interrupt
    };

    let command = serde_json::json!({
        "type": "interrupt",
        "sessionId": session_id,
    });

    let mut guard = sidecar.stdin.lock().await;
    if let Some(stdin) = guard.as_mut() {
        send_command(stdin, &command).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The M1 serial guard: `run_task` rejects with "a task is already running"
    /// whenever a task is active. We exercise the guard predicate directly (the
    /// `tauri::command` wrapper needs an `AppHandle` we can't build in a unit
    /// test, but the decision is purely `Sidecar::active()`).
    #[test]
    fn serial_guard_blocks_when_a_task_is_active() {
        let sidecar = Sidecar::default();
        assert!(sidecar.active().is_none(), "starts idle");

        // First run claims the slot.
        sidecar.set_active(Some("task-1".to_string()));
        assert_eq!(sidecar.active().as_deref(), Some("task-1"));

        // The guard `run_task` uses: a second run must be refused while one is in
        // flight.
        let already_running = sidecar.active().is_some();
        assert!(already_running, "guard must see the active task");

        let err: Result<(), String> = if already_running {
            Err("a task is already running".to_string())
        } else {
            Ok(())
        };
        assert_eq!(err, Err("a task is already running".to_string()));
    }

    #[test]
    fn slot_releases_on_terminal_event() {
        let sidecar = Sidecar::default();
        sidecar.set_active(Some("task-1".to_string()));
        assert!(sidecar.active().is_some());

        // A terminal event (session-completed / session-failed) clears the slot,
        // letting the next run pass the guard.
        sidecar.set_active(None);
        assert!(
            sidecar.active().is_none(),
            "slot must be free after a terminal transition"
        );
    }

    #[test]
    fn active_is_the_last_claimed_task() {
        let sidecar = Sidecar::default();
        sidecar.set_active(Some("a".to_string()));
        sidecar.set_active(Some("b".to_string()));
        assert_eq!(sidecar.active().as_deref(), Some("b"));
    }
}
