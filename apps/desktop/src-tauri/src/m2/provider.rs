//! The provider seam (M2 §7 of the design doc).
//!
//! The seam between the Rust core and an agent backend is the **sidecar process
//! boundary**: each provider is a separate sidecar speaking the one NDJSON
//! `SurfaceCommand`/`NightcoreEvent` protocol. This trait is the Rust-side
//! abstraction. M2 ships exactly one implementation ([`SidecarProvider`], wrapping
//! the persistent Bun child); a Codex/other provider later is an additive sidecar
//! binary + factory arm, never a `match provider` branch in the core. The core
//! only ever consumes the normalized `NightcoreEvent` stream.
//!
//! ## Session ↔ task correlation
//!
//! The engine assigns a session id and echoes it back via a `session-started`
//! **event** — there is no synchronous reply to `start-session`. To run N sessions
//! concurrently through one sidecar, the provider keeps a **pending-launch FIFO**:
//! `start_session` pushes the task id under the same lock that serializes the
//! stdin write, so the i-th `start-session` line and the i-th `session-started`
//! event line line up (stdout is ordered; the engine emits `session-started`
//! synchronously, in command order). The reader calls [`correlate`] on the first
//! sighting of a session id to bind it to the task that launched it. This needs
//! **zero sidecar changes** — the sidecar stays dumb.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::{ChildStdin, Command};
use tokio::sync::Mutex as AsyncMutex;

use crate::platform::resolve_bun_program;

/// A driveable agent backend. Today: the Bun Claude sidecar. Later: a Codex
/// sidecar speaking the same protocol — selected by config, not by branching in
/// the core. Implementations correlate the session id they obtain back to the
/// task that owns the run via [`Provider::correlate`] / [`Provider::task_for`].
#[async_trait]
pub trait Provider: Send + Sync {
    /// Ensure the backend is running, spawning it lazily. Idempotent. M2 callers
    /// that need the stdout reader use [`SidecarProvider::spawn`] directly (it
    /// returns the stdout to install a reader on); this bare method pins the seam
    /// for a future provider whose reader is self-contained.
    #[allow(dead_code)]
    async fn ensure_started(&self) -> Result<(), String>;

    /// Start one run for `task_id`. Writes `start-session` and records the task in
    /// the pending-launch FIFO so the next `session-started` event correlates to
    /// it. The session id arrives asynchronously via an event, not this return.
    ///
    /// The parameters mirror the `start-session` wire fields 1:1 (prompt, model,
    /// effort, cwd, permissionMode, kind, plus the SDK-guardrail fields maxTurns/
    /// maxBudgetUsd/resumeSessionId); a struct would just re-pack the protocol
    /// payload, so the flat list is the clearer seam here.
    #[allow(clippy::too_many_arguments)]
    async fn start_session(
        &self,
        task_id: &str,
        prompt: String,
        model: Option<String>,
        effort: Option<String>,
        cwd: Option<PathBuf>,
        permission_mode: Option<String>,
        kind: &str,
        guardrails: Guardrails,
    ) -> Result<(), String>;

    /// Best-effort interrupt of a run by session id.
    async fn interrupt(&self, session_id: u64) -> Result<(), String>;

    /// Change a live run's permission mode (SDK `setPermissionMode`). Used by the
    /// plan-approval gate to switch the SAME session to `acceptEdits` so it builds
    /// the approved plan without re-prompting.
    async fn set_permission_mode(&self, session_id: u64, mode: &str) -> Result<(), String>;

    /// Decide a pending permission request for a run by sending an
    /// `approve-permission` SurfaceCommand. An `allow` echoes `updated_input` back
    /// to the engine (the SDK requires `updatedInput` on allow; the engine fills
    /// the original input when `None`). A `deny` carries a short `message` returned
    /// to the model. Used both for interactive approvals and the fail-closed deny
    /// the core issues when a task is cancelled/aborted with a parked request.
    async fn decide_permission(
        &self,
        session_id: u64,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(), String>;
}

/// The SDK-guardrail fields threaded into a `start-session` payload alongside the
/// core wire fields: the autonomy ceilings (`max_turns`/`max_budget_usd`, engine
/// `Options.maxTurns`/`maxBudgetUsd`) and the resume id (`resume_session_id`, the
/// persisted SDK session UUID → engine `Options.resume`). All `None` ⇒ inherit the
/// `@nightcore/config` defaults and start cold. `resume_session_id` is bookkeeping,
/// not a secret, but is never logged at info/telemetry.
#[derive(Debug, Clone, Default)]
pub struct Guardrails {
    pub max_turns: Option<u32>,
    pub max_budget_usd: Option<f64>,
    pub resume_session_id: Option<String>,
}

/// The child's piped output streams, handed to `sidecar::ensure_reader` once on
/// spawn: `stdout` carries the NDJSON event protocol, `stderr` the human/structured
/// logs that the reader drains into the Rust `tracing` sink.
pub struct SidecarStreams {
    pub stdout: tokio::process::ChildStdout,
    pub stderr: tokio::process::ChildStderr,
}

/// A surface decision for a parked permission request. Mirrors the contract's
/// `PermissionDecision` (allow/deny) in core terms so callers don't construct raw
/// JSON.
#[derive(Debug, Clone)]
pub enum PermissionDecision {
    /// Allow the tool call, optionally rewriting its input. `None` echoes the
    /// original input (the engine defaults to it when omitted).
    Allow { updated_input: Option<Value> },
    /// Deny the tool call, returning `message` to the model.
    Deny { message: String },
}

/// The persistent Bun sidecar provider — the M1 child generalized to N sessions.
///
/// Holds the stdin writer (commands are written from async handlers, behind an
/// async mutex) and the session↔task correlation state (a sync mutex shared with
/// the reader task). The reader itself lives in `sidecar.rs`, which owns the Tauri
/// `AppHandle` to emit events; this struct owns only the protocol plumbing.
pub struct SidecarProvider {
    stdin: AsyncMutex<Option<ChildStdin>>,
    /// `Some(stdout)` exactly once, after `spawn`, handed to the reader installer.
    correlation: Mutex<Correlation>,
    entry: PathBuf,
    cwd: PathBuf,
}

/// Session↔task correlation: the live `sessionId → taskId` map plus the
/// pending-launch FIFO of task ids awaiting their first `session-started`. Also
/// records when each session was first correlated, so a terminal can log the run's
/// wall-clock `duration_ms` (observability #5).
#[derive(Default)]
struct Correlation {
    by_session: HashMap<u64, String>,
    pending: VecDeque<String>,
    started_at: HashMap<u64, std::time::Instant>,
}

impl SidecarProvider {
    /// A provider that will spawn `bun run <entry>` in `cwd` on first use.
    pub fn new(entry: PathBuf, cwd: PathBuf) -> Self {
        Self {
            stdin: AsyncMutex::new(None),
            correlation: Mutex::new(Correlation::default()),
            entry,
            cwd,
        }
    }

    /// Whether the child has been spawned. (Diagnostic accessor for a future
    /// health/status command; `spawn` is idempotent so callers don't need it.)
    #[allow(dead_code)]
    pub async fn is_running(&self) -> bool {
        self.stdin.lock().await.is_some()
    }

    /// Spawn the sidecar child, store its stdin writer, and return its stdout +
    /// stderr for the caller to install readers on. Idempotent: returns `Ok(None)`
    /// when the child is already running. Holds the stdin lock for the spawn.
    ///
    /// **stderr is piped, not inherited** (M4.5 §B4): the sidecar's structured
    /// leveled lines would otherwise be thrown uncaptured at the host terminal. The
    /// caller drains stderr into the Rust `tracing` sink. stdout stays the pure
    /// NDJSON protocol — only stderr carries logs.
    pub async fn spawn(&self) -> Result<Option<SidecarStreams>, String> {
        let mut guard = self.stdin.lock().await;
        if guard.is_some() {
            return Ok(None);
        }

        let started = std::time::Instant::now();
        let bun = resolve_bun_program();
        let mut child = Command::new(&bun.program)
            .args(&bun.prefix_args)
            .arg("run")
            .arg(&self.entry)
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!(
                    "failed to spawn sidecar (no launchable bun binary found — \
                 on Windows, bun.exe must be on PATH or reachable via the npm shim): {e}"
                )
            })?;
        // Sidecar process lifecycle (#4) + spawn latency (#5). The pid + duration are
        // operational facts — no prompt/env/secret is logged.
        tracing::info!(
            target: "sidecar",
            pid = child.id(),
            duration_ms = started.elapsed().as_millis() as u64,
            "sidecar process spawned"
        );

        let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("sidecar stderr unavailable")?;
        *guard = Some(stdin);

        // Keep the child alive for the app's lifetime by detaching it onto a task
        // that just owns the handle; the readers (installed by the caller on the
        // returned streams) are what actually drain it.
        tokio::spawn(async move {
            let _child = child;
            std::future::pending::<()>().await;
        });

        Ok(Some(SidecarStreams { stdout, stderr }))
    }

    /// Record that `task_id` is launching a run. Called under the stdin lock right
    /// before the `start-session` write so the FIFO order matches the wire order.
    fn push_pending(&self, task_id: &str) {
        self.correlation
            .lock()
            .expect("correlation poisoned")
            .pending
            .push_back(task_id.to_string());
    }

    /// Bind a freshly-seen `session_id` to the task at the front of the pending
    /// FIFO. Called by the reader the first time it sees a session id. Returns the
    /// task id it bound, if any pending launch was waiting.
    pub fn correlate(&self, session_id: u64) -> Option<String> {
        let mut c = self.correlation.lock().expect("correlation poisoned");
        if let Some(existing) = c.by_session.get(&session_id) {
            return Some(existing.clone());
        }
        let Some(task_id) = c.pending.pop_front() else {
            // A session id with no pending launch to bind — the FIFO desynced (a
            // launch was evicted, or the engine emitted an unexpected session).
            // Logged so a correlation desync is visible rather than a silent drop.
            tracing::warn!(target: "nightcore", session_id, "correlation desync: session id with no pending launch");
            return None;
        };
        tracing::info!(target: "nightcore", task_id = %task_id, session_id, "bound session to task");
        c.by_session.insert(session_id, task_id.clone());
        c.started_at
            .entry(session_id)
            .or_insert_with(std::time::Instant::now);
        Some(task_id)
    }

    /// The wall-clock duration since a session first correlated, in milliseconds, if
    /// it is still tracked. Read on a terminal event to log the run's `duration_ms`
    /// (observability #5). `None` once the session has been forgotten.
    pub fn run_duration_ms(&self, session_id: u64) -> Option<u64> {
        self.correlation
            .lock()
            .expect("correlation poisoned")
            .started_at
            .get(&session_id)
            .map(|t| t.elapsed().as_millis() as u64)
    }

    /// Evict the most-recently-pushed pending launch for `task_id` if it has not yet
    /// correlated to a session id (concurrency #5). Called when a launch is torn
    /// down (cancel/abort/circuit-break) before its `session-started` arrived, so a
    /// later, unrelated `session-started` can't mis-bind to this dead launch and
    /// poison the FIFO. A no-op once the launch has correlated (then `forget`
    /// drops the binding instead). Returns whether an entry was removed.
    pub fn evict_pending(&self, task_id: &str) -> bool {
        let mut c = self.correlation.lock().expect("correlation poisoned");
        // Already correlated ⇒ nothing pending to evict (forget handles the binding).
        if c.by_session.values().any(|t| t == task_id) {
            return false;
        }
        // Remove the last pending occurrence (the most recent launch for this task).
        if let Some(idx) = c.pending.iter().rposition(|t| t == task_id) {
            c.pending.remove(idx);
            tracing::info!(target: "nightcore", task_id, "evicted uncorrelated pending launch");
            return true;
        }
        false
    }

    /// The task id a session id is bound to, if already correlated. (Read-back
    /// accessor; the reader correlates via [`correlate`](Self::correlate). Kept for
    /// diagnostics and tests.)
    #[allow(dead_code)]
    pub fn task_for(&self, session_id: u64) -> Option<String> {
        self.correlation
            .lock()
            .expect("correlation poisoned")
            .by_session
            .get(&session_id)
            .cloned()
    }

    /// Forget a session↔task binding once the run reaches a terminal state, so the
    /// map doesn't grow unboundedly across a long session.
    pub fn forget(&self, session_id: u64) {
        let mut c = self.correlation.lock().expect("correlation poisoned");
        c.by_session.remove(&session_id);
        c.started_at.remove(&session_id);
    }

    /// The session id currently bound to `task_id`, if any. Used to interrupt a
    /// specific run by task.
    pub fn session_for(&self, task_id: &str) -> Option<u64> {
        let c = self.correlation.lock().expect("correlation poisoned");
        c.by_session
            .iter()
            .find(|(_, t)| t.as_str() == task_id)
            .map(|(sid, _)| *sid)
    }

    /// Every currently-bound session id. Used to interrupt all in-flight runs on a
    /// stop / circuit-breaker pause.
    pub fn live_sessions(&self) -> Vec<u64> {
        self.correlation
            .lock()
            .expect("correlation poisoned")
            .by_session
            .keys()
            .copied()
            .collect()
    }

    /// Tear down provider state after the sidecar child has exited (crash recovery,
    /// #11): drop the dead stdin writer so the next [`spawn`](Self::spawn) re-spawns
    /// a fresh child, and clear ALL correlation (live bindings, pending launches,
    /// timers). Returns the task ids that had a live session bound, so the caller can
    /// fail/release their leased runs. After this, `spawn` is no longer a no-op.
    pub async fn reset_after_crash(&self) -> Vec<String> {
        // Drop the stdin handle first: a write to a dead child would error anyway,
        // and clearing it makes `spawn` re-spawn instead of returning Ok(None).
        *self.stdin.lock().await = None;
        let mut c = self.correlation.lock().expect("correlation poisoned");
        let orphaned: Vec<String> = c.by_session.values().cloned().collect();
        c.by_session.clear();
        c.pending.clear();
        c.started_at.clear();
        orphaned
    }

    /// Write one `SurfaceCommand` as an NDJSON line to the child's stdin.
    async fn write_line(stdin: &mut ChildStdin, command: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(command).map_err(|e| e.to_string())?;
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("failed to write to sidecar: {e}"))?;
        stdin.flush().await.map_err(|e| e.to_string())
    }
}

#[async_trait]
impl Provider for SidecarProvider {
    async fn ensure_started(&self) -> Result<(), String> {
        // The reader install is owned by `sidecar.rs` (it needs the AppHandle), so
        // the bare trait method only guarantees the child exists. Callers that need
        // the stdout reader use `spawn` directly.
        let _ = self.spawn().await?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn start_session(
        &self,
        task_id: &str,
        prompt: String,
        model: Option<String>,
        effort: Option<String>,
        cwd: Option<PathBuf>,
        permission_mode: Option<String>,
        kind: &str,
        guardrails: Guardrails,
    ) -> Result<(), String> {
        // M4.7 §E: `effort` is now forwarded; the engine already threads
        // `command.effort` into the SDK `Options`. A `null` effort lets the model
        // decide (the engine omits the option), preserving pre-M4.7 behavior.
        //
        // SDK-guardrails: `maxTurns`/`maxBudgetUsd`/`resumeSessionId` are forwarded
        // additively. A `null` for any of them lets the engine inherit the
        // `@nightcore/config` default (and start cold), preserving prior behavior.
        let command = serde_json::json!({
            "type": "start-session",
            "prompt": prompt,
            "model": model,
            "effort": effort,
            "cwd": cwd.map(|p| p.to_string_lossy().to_string()),
            "permissionMode": permission_mode,
            "kind": kind,
            "maxTurns": guardrails.max_turns,
            "maxBudgetUsd": guardrails.max_budget_usd,
            "resumeSessionId": guardrails.resume_session_id,
        });

        // Push the pending launch and write the line under the same lock so the
        // FIFO can't be reordered against the wire by a concurrent launch.
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or("sidecar stdin unavailable")?;
        self.push_pending(task_id);
        if let Err(e) = Self::write_line(stdin, &command).await {
            // The write failed: undo the pending push we just made so it can't
            // mis-correlate a later session.
            self.correlation
                .lock()
                .expect("correlation poisoned")
                .pending
                .pop_back();
            return Err(e);
        }
        Ok(())
    }

    async fn interrupt(&self, session_id: u64) -> Result<(), String> {
        let command = serde_json::json!({ "type": "interrupt", "sessionId": session_id });
        let mut guard = self.stdin.lock().await;
        if let Some(stdin) = guard.as_mut() {
            Self::write_line(stdin, &command).await?;
        }
        Ok(())
    }

    async fn set_permission_mode(&self, session_id: u64, mode: &str) -> Result<(), String> {
        let command = serde_json::json!({
            "type": "set-permission-mode",
            "sessionId": session_id,
            "mode": mode,
        });
        let mut guard = self.stdin.lock().await;
        if let Some(stdin) = guard.as_mut() {
            Self::write_line(stdin, &command).await?;
        }
        Ok(())
    }

    async fn decide_permission(
        &self,
        session_id: u64,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(), String> {
        let decision = match decision {
            // The engine echoes the parked input when `updatedInput` is omitted, so
            // a bare allow is valid; include it only when the surface rewrote it.
            PermissionDecision::Allow {
                updated_input: None,
            } => {
                serde_json::json!({ "behavior": "allow" })
            }
            PermissionDecision::Allow {
                updated_input: Some(input),
            } => serde_json::json!({ "behavior": "allow", "updatedInput": input }),
            PermissionDecision::Deny { message } => {
                serde_json::json!({ "behavior": "deny", "message": message })
            }
        };
        let command = serde_json::json!({
            "type": "approve-permission",
            "sessionId": session_id,
            "requestId": request_id,
            "decision": decision,
        });
        let mut guard = self.stdin.lock().await;
        if let Some(stdin) = guard.as_mut() {
            Self::write_line(stdin, &command).await?;
        }
        Ok(())
    }
}

/// Read one NDJSON line into a `serde_json::Value`, skipping blanks. Shared by the
/// reader loop. Returns `None` for a blank line.
pub fn parse_line(raw: &str) -> Option<Result<Value, String>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    Some(serde_json::from_str(raw).map_err(|e| format!("non-JSON sidecar line ({e}): {raw}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> SidecarProvider {
        SidecarProvider::new(PathBuf::from("/tmp/entry.ts"), PathBuf::from("/tmp"))
    }

    #[test]
    fn correlation_binds_in_fifo_order() {
        let p = provider();
        // Two launches queued in order; the engine assigns ids 0 then 1.
        p.push_pending("task-a");
        p.push_pending("task-b");

        assert_eq!(p.correlate(0).as_deref(), Some("task-a"));
        assert_eq!(p.correlate(1).as_deref(), Some("task-b"));
        // Re-seeing a bound id returns the same task (idempotent).
        assert_eq!(p.correlate(0).as_deref(), Some("task-a"));
    }

    #[test]
    fn correlate_with_no_pending_launch_is_none() {
        let p = provider();
        assert!(
            p.correlate(7).is_none(),
            "an event with no pending launch can't be correlated"
        );
    }

    #[test]
    fn task_for_reads_back_a_binding() {
        let p = provider();
        p.push_pending("task-x");
        assert!(p.task_for(3).is_none(), "unseen id is unbound");
        p.correlate(3);
        assert_eq!(p.task_for(3).as_deref(), Some("task-x"));
    }

    #[test]
    fn forget_drops_a_binding() {
        let p = provider();
        p.push_pending("t");
        p.correlate(5);
        assert_eq!(p.task_for(5).as_deref(), Some("t"));
        p.forget(5);
        assert!(p.task_for(5).is_none(), "binding cleared on terminal");
    }

    #[test]
    fn concurrent_launches_keep_their_own_sessions() {
        // Three tasks launched before any session-started arrives (true M2
        // concurrency); ids come back interleaved-but-ordered.
        let p = provider();
        for id in ["a", "b", "c"] {
            p.push_pending(id);
        }
        assert_eq!(p.correlate(10).as_deref(), Some("a"));
        assert_eq!(p.correlate(11).as_deref(), Some("b"));
        assert_eq!(p.correlate(12).as_deref(), Some("c"));
        assert_eq!(p.task_for(11).as_deref(), Some("b"));
    }

    #[test]
    fn evict_pending_removes_an_uncorrelated_launch() {
        // concurrency #5: a launch cancelled before its session-started must be
        // evicted so the FIFO doesn't mis-bind a later session to the dead launch.
        let p = provider();
        p.push_pending("task-a");
        p.push_pending("task-b");

        // task-a is cancelled before any session arrives → evict its pending entry.
        assert!(
            p.evict_pending("task-a"),
            "an uncorrelated launch is evicted"
        );
        // Now the FIFO head is task-b; the next session binds to it (not to task-a).
        assert_eq!(p.correlate(0).as_deref(), Some("task-b"));
        // A second evict of the same task is a no-op (nothing pending left).
        assert!(!p.evict_pending("task-a"));
    }

    #[test]
    fn evict_pending_is_a_noop_once_correlated() {
        // Once a launch has correlated to a session, evict_pending must NOT touch it
        // (the binding is dropped by `forget` on terminal, not by eviction).
        let p = provider();
        p.push_pending("task-a");
        p.correlate(7);
        assert!(
            !p.evict_pending("task-a"),
            "a correlated launch is not evicted"
        );
        assert_eq!(p.task_for(7).as_deref(), Some("task-a"), "binding intact");
    }

    #[test]
    fn parse_line_skips_blanks_and_reports_bad_json() {
        assert!(parse_line("   ").is_none());
        assert!(parse_line(r#"{"type":"x"}"#).unwrap().is_ok());
        assert!(parse_line("{not json").unwrap().is_err());
    }
}
