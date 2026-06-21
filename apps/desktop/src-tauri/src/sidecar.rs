//! Spawning and driving the Bun provider sidecar.
//!
//! Protocol (line-delimited JSON over the child's stdio):
//!   - we WRITE one `SurfaceCommand` JSON object per line to the sidecar's stdin
//!   - we READ one `NightcoreEvent` JSON object per line from its stdout
//!   - the sidecar's stderr is human logs; we inherit it for now
//!
//! Each `nc:event` line is forwarded verbatim to the webview, which owns the
//! event schema. M0 spawns a fresh sidecar per prompt and tears it down when the
//! session reaches a terminal event; M1 will keep one long-lived sidecar and
//! multiplex sessions/tasks over it.

use std::path::PathBuf;
use std::process::Stdio;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// Absolute path to the Bun sidecar entrypoint (dev: TS source in the workspace).
/// Resolved from this crate's location so it's independent of the launch cwd.
fn sidecar_entry() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sidecar/src/index.ts")
}

/// Workspace root (`apps/desktop/src-tauri` → up three) — the cwd the agent runs
/// in for M0. M1 will pass the active project's path / git worktree here.
fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// True once an event marks the session terminal, so the reader loop can stop
/// and let the sidecar process be reaped.
fn is_terminal(event: &serde_json::Value) -> bool {
    matches!(
        event.get("type").and_then(|t| t.as_str()),
        Some("session-completed") | Some("session-failed")
    )
}

/// Run one prompt through a freshly spawned sidecar, relaying its event stream to
/// the frontend as `nc:event`. Returns once the sidecar is launched and the
/// prompt is sent; streaming continues on a background task.
#[tauri::command]
pub async fn start_prompt(
    app: AppHandle,
    prompt: String,
    model: Option<String>,
) -> Result<(), String> {
    let mut child = Command::new("bun")
        .arg("run")
        .arg(sidecar_entry())
        .current_dir(workspace_root())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar (is `bun` on PATH?): {e}"))?;

    let mut stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;

    // Send the start-session command as one NDJSON line.
    let command = serde_json::json!({
        "type": "start-session",
        "prompt": prompt,
        "model": model,
    });
    let mut line = serde_json::to_string(&command).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("failed to send prompt to sidecar: {e}"))?;
    stdin.flush().await.map_err(|e| e.to_string())?;

    // Relay stdout events until the session ends, then reap the child. `stdin` is
    // moved in and dropped at the end so the sidecar sees EOF and exits cleanly.
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(raw)) => {
                    let raw = raw.trim();
                    if raw.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<serde_json::Value>(raw) {
                        Ok(event) => {
                            let done = is_terminal(&event);
                            let _ = app.emit("nc:event", event);
                            if done {
                                break;
                            }
                        }
                        Err(e) => eprintln!("sidecar emitted non-JSON line ({e}): {raw}"),
                    }
                }
                Ok(None) => break, // stdout closed
                Err(e) => {
                    eprintln!("error reading sidecar stdout: {e}");
                    break;
                }
            }
        }
        drop(stdin);
        let _ = child.wait().await;
    });

    Ok(())
}
