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
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::{ChildStdin, Command};
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;

use crate::contracts::{
    AnswerQuestionAnswerUnion, EffortLevel, PermissionDecision as WirePermissionDecision,
    PermissionMode as WirePermissionMode, SurfaceCommand, SurfaceQuery, TaskKind as WireTaskKind,
};
use crate::platform::resolve_bun_program;

/// How long a session query waits for its correlated `query-result` reply before
/// giving up. These are local disk reads via the sidecar's SDK — fast — but the
/// bound keeps a dropped/abandoned reply from leaking a pending entry forever.
const QUERY_TIMEOUT: Duration = Duration::from_secs(20);

/// Parse a wire-string enum value into its generated contract enum, surfacing an
/// invalid value as a typed error rather than letting it reach (and be rejected
/// by) the sidecar's zod validation. The provider receives `effort`/`mode`/`kind`
/// as free strings from upstream task records; routing them through the generated
/// enums is the point of the codegen migration — the enum is the single source of
/// truth for which values are valid on the wire.
fn parse_wire_enum<T: serde::de::DeserializeOwned>(field: &str, value: &str) -> Result<T, String> {
    serde_json::from_value(Value::String(value.to_string()))
        .map_err(|e| format!("invalid {field} value {value:?} for the contract: {e}"))
}

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

    /// Answer a parked `AskUserQuestion` dialog for a run by sending an
    /// `answer-question` SurfaceCommand. The `answer` is the wire union the engine
    /// folds onto the SDK dialog reply (`answer` → the user's `answers`; `cancel` →
    /// settle the dialog as cancelled). Unlike `decide_permission`, no fail-closed
    /// drain on cancel is needed: the engine settles a parked dialog on session
    /// abort/teardown, so there is no Rust-side question registry.
    async fn send_answer(
        &self,
        session_id: u64,
        request_id: &str,
        answer: AnswerQuestionAnswerUnion,
    ) -> Result<(), String>;

    /// Issue a request/reply `SurfaceQuery` and await its correlated `query-result`
    /// reply. The provider injects a fresh `requestId`, registers a pending
    /// one-shot under it, writes the query line, then awaits the reply the reader
    /// fulfills via [`Provider::correlate_reply`]. Returns the raw `query-result`
    /// payload (a `Value`) for the caller to map. Unlike `start-session`, this is
    /// a synchronous-feeling RPC over the otherwise one-way NDJSON protocol. The
    /// `request_id` field of `query` is OVERWRITTEN with the generated id.
    async fn query(&self, query: SurfaceQuery) -> Result<Value, String>;

    /// Read the provider's RESOLVED configuration for a project (the read-only
    /// inspector): its MCP servers, skills, subagents, and scalar extras. Default-
    /// implemented over [`Provider::query`] with a `get-provider-config`
    /// `SurfaceQuery`, so the Bun sidecar inherits it unchanged. The provider seam
    /// is the override point: a future Codex provider that can't report this
    /// returns a snapshot whose sections are `unsupported`, or overrides this
    /// method — WITHOUT a `match provider` branch in the inspector. `dir` is the
    /// project root resolution keys off; `None` ⇒ the engine's cwd. Returns the raw
    /// `query-result` payload (a `Value`) for the caller to map.
    async fn provider_config(&self, dir: Option<String>) -> Result<Value, String> {
        let query = SurfaceQuery::GetProviderConfig {
            // `requestId` is overwritten by `query` with a fresh uuid.
            request_id: String::new(),
            dir,
        };
        self.query(query).await
    }

    /// Fulfill a pending query reply. Called by the reader on a `query-result`
    /// event with the request id it carries; a no-op for an unknown/late id.
    fn correlate_reply(&self, request_id: &str, reply: Value);
}

/// The per-session config threaded into a `start-session` payload alongside the
/// core wire fields. Carries the SDK autonomy ceilings (`max_turns`/`max_budget_usd`
/// → engine `Options.maxTurns`/`maxBudgetUsd`), the resume id (`resume_session_id`,
/// the persisted SDK session UUID → engine `Options.resume`), and the resolved
/// external MCP servers (`mcp_servers`, enabled entries only → engine
/// `Options.mcpServers`). All ceilings/resume `None` ⇒ inherit the
/// `@nightcore/config` defaults and start cold; an empty `mcp_servers` ⇒ inject
/// none (the pre-feature shape). `resume_session_id` and the MCP `env`/`headers`
/// values may be sensitive, but are never logged at info/telemetry.
#[derive(Debug, Clone, Default)]
pub struct Guardrails {
    pub max_turns: Option<u32>,
    pub max_budget_usd: Option<f64>,
    pub resume_session_id: Option<String>,
    pub mcp_servers: Vec<crate::contracts::McpServerEntry>,
    /// Pre-flight Context Pack (Lock, feature #4): the curated, Nightcore-controlled
    /// project Constitution read from `<project>/.nightcore/context.md` → engine
    /// `appendContextPack` → composed into the SDK `appendSystemPrompt` BEFORE the
    /// kind-preset persona. `None` ⇒ inject no pack (the pre-feature shape: either no
    /// `context.md`, or the per-project toggle is off).
    pub append_context_pack: Option<String>,
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
    /// Pending session-query replies, keyed by the `requestId` written on the wire.
    /// The query awaits its one-shot; the reader fulfills it from a `query-result`
    /// event. Separate from `correlation` (sessions↔tasks) — a query has no session.
    pending_replies: Mutex<HashMap<String, oneshot::Sender<Value>>>,
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

/// The compiled sidecar binary's base name. Tauri's `externalBin` config copies
/// `binaries/nightcore-sidecar-<target-triple>` next to the app executable under
/// this name (no triple suffix at the install site). On Windows it carries `.exe`.
const SIDECAR_BIN: &str = "nightcore-sidecar";

impl SidecarProvider {
    /// A provider that will spawn the sidecar in `cwd` on first use. In debug
    /// builds (`tauri dev`) this is `bun run <entry>` against the TypeScript source;
    /// in release builds it is the compiled binary bundled next to the app.
    pub fn new(entry: PathBuf, cwd: PathBuf) -> Self {
        Self {
            stdin: AsyncMutex::new(None),
            correlation: Mutex::new(Correlation::default()),
            pending_replies: Mutex::new(HashMap::new()),
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

    /// Resolve the compiled sidecar binary that Tauri's `externalBin` places next
    /// to the app executable, if it exists. Tauri copies the triple-suffixed
    /// `binaries/nightcore-sidecar-<triple>` to a plain `nightcore-sidecar`
    /// (`.exe` on Windows) in the executable's directory — on macOS that is
    /// `Nightcore.app/Contents/MacOS/`, the same dir as the app binary. Returns
    /// `None` if the current exe or the binary can't be resolved, so the caller can
    /// fall back to `bun run` instead of dead-ending.
    fn release_sidecar_path() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        let name = if cfg!(windows) {
            format!("{SIDECAR_BIN}.exe")
        } else {
            SIDECAR_BIN.to_string()
        };
        let path = dir.join(name);
        path.exists().then_some(path)
    }

    /// Whether the process is running from inside a packaged app bundle (debug OR
    /// release) rather than a raw `tauri dev` target binary. A bundled app must spawn
    /// the sidecar Tauri placed next to the executable; only a genuine `tauri dev`
    /// run wants `bun run` against the live TypeScript for hot reload.
    ///
    /// We can't key this off `cfg!(debug_assertions)` alone: `tauri build --debug`
    /// produces a *debug* build that is nonetheless a real bundle, and it copies the
    /// compiled sidecar into the `.app` — so a debug bundle that fell through to the
    /// dev path would try `bun run` against TypeScript that isn't there (and a GUI
    /// launch has no `bun` on PATH), failing with `os error 2`. macOS detects the
    /// `<App>.app/Contents/MacOS/<exe>` layout directly; other platforms fall back to
    /// the build profile (release ⇒ bundled), preserving prior behavior.
    fn running_as_bundle() -> bool {
        #[cfg(target_os = "macos")]
        {
            if let Ok(exe) = std::env::current_exe() {
                if Self::exe_in_app_bundle(&exe) {
                    return true;
                }
            }
        }
        !cfg!(debug_assertions)
    }

    /// Pure classifier for [`running_as_bundle`]: is `exe` inside a macOS `.app`
    /// bundle? A debug bundle lives under `target/debug/bundle/macos/<App>.app/…`, so
    /// the target-dir path is NOT a reliable "dev" signal — only an `.app` ancestor
    /// is. Extracted so the layout logic is unit-testable without a real executable.
    #[cfg(target_os = "macos")]
    fn exe_in_app_bundle(exe: &std::path::Path) -> bool {
        exe.ancestors()
            .any(|ancestor| ancestor.extension().is_some_and(|ext| ext == "app"))
    }

    /// Build the (unspawned) [`Command`] for the sidecar, with program, args, and
    /// working directory set — but no stdio/spawn, which [`spawn`](Self::spawn)
    /// owns. The bundled/dev split is the only thing that varies here:
    ///
    /// - **Bundled app (`tauri build`, release OR `--debug`):** the compiled binary
    ///   Tauri placed next to the app executable. If it can't be resolved
    ///   (missing/unbundled), fall back to `bun run <entry>` with a warning so the
    ///   app degrades instead of failing to start.
    /// - **`tauri dev`:** `bun run <entry>` against the TypeScript source — the hot
    ///   path, so sidecar edits reload without a recompile.
    fn spawn_command(&self) -> Command {
        if Self::running_as_bundle() {
            if let Some(bin) = Self::release_sidecar_path() {
                let mut cmd = Command::new(bin);
                cmd.current_dir(&self.cwd);
                return cmd;
            }
            tracing::warn!(
                target: "sidecar",
                entry = %self.entry.display(),
                "running as an app bundle but the sidecar binary wasn't found next to \
                 the app executable; falling back to `bun run` against the TypeScript entry"
            );
        }
        let bun = resolve_bun_program();
        let mut cmd = Command::new(&bun.program);
        cmd.args(&bun.prefix_args)
            .arg("run")
            .arg(&self.entry)
            .current_dir(&self.cwd);
        cmd
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
        let mut child = self
            .spawn_command()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!(
                    "failed to spawn sidecar (release: the bundled `nightcore-sidecar` \
                 next to the app executable must be launchable; dev: a launchable bun \
                 binary must be found — on Windows, bun.exe must be on PATH or reachable \
                 via the npm shim): {e}"
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
        crate::sync::lock_or_recover(&self.correlation)
            .pending
            .push_back(task_id.to_string());
    }

    /// Bind a freshly-seen `session_id` to the task at the front of the pending
    /// FIFO. Called by the reader the first time it sees a session id. Returns the
    /// task id it bound, if any pending launch was waiting.
    pub fn correlate(&self, session_id: u64) -> Option<String> {
        let mut c = crate::sync::lock_or_recover(&self.correlation);
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
        crate::sync::lock_or_recover(&self.correlation)
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
        let mut c = crate::sync::lock_or_recover(&self.correlation);
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
        crate::sync::lock_or_recover(&self.correlation)
            .by_session
            .get(&session_id)
            .cloned()
    }

    /// Forget a session↔task binding once the run reaches a terminal state, so the
    /// map doesn't grow unboundedly across a long session.
    pub fn forget(&self, session_id: u64) {
        let mut c = crate::sync::lock_or_recover(&self.correlation);
        c.by_session.remove(&session_id);
        c.started_at.remove(&session_id);
    }

    /// The session id currently bound to `task_id`, if any. Used to interrupt a
    /// specific run by task.
    pub fn session_for(&self, task_id: &str) -> Option<u64> {
        let c = crate::sync::lock_or_recover(&self.correlation);
        c.by_session
            .iter()
            .find(|(_, t)| t.as_str() == task_id)
            .map(|(sid, _)| *sid)
    }

    /// Every currently-bound session id. Used to interrupt all in-flight runs on a
    /// stop / circuit-breaker pause.
    pub fn live_sessions(&self) -> Vec<u64> {
        crate::sync::lock_or_recover(&self.correlation)
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
        // Drop every pending query sender so any awaiting `query` returns an error
        // (a `RecvError`) instead of hanging on a reply that will never arrive from
        // the dead child.
        crate::sync::lock_or_recover(&self.pending_replies).clear();
        let mut c = crate::sync::lock_or_recover(&self.correlation);
        let orphaned: Vec<String> = c.by_session.values().cloned().collect();
        c.by_session.clear();
        c.pending.clear();
        c.started_at.clear();
        orphaned
    }

    /// Dispatch a run-scoped command (`start-analysis`/`cancel-analysis` for Insight,
    /// `start-harness-scan`/`cancel-harness-scan` for Harness) to the sidecar. Unlike
    /// `start_session`, these correlate by `runId` (carried in the command and echoed on
    /// every `analysis-*`/`harness-*` event), so there is NO pending-launch FIFO push —
    /// the line is written directly. The sidecar's `SessionManager` owns the fan-out; the
    /// core only sees the run-scoped event stream.
    pub async fn dispatch_command(&self, command: SurfaceCommand) -> Result<(), String> {
        let payload = serde_json::to_value(&command).map_err(|e| e.to_string())?;
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or("sidecar stdin unavailable")?;
        Self::write_line(stdin, &payload).await
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
        // `command.effort` into the SDK `Options`. An absent effort lets the model
        // decide (the engine omits the option), preserving pre-M4.7 behavior.
        //
        // SDK-guardrails: `maxTurns`/`maxBudgetUsd`/`resumeSessionId` are forwarded
        // additively. An absent value for any of them lets the engine inherit the
        // `@nightcore/config` default (and start cold), preserving prior behavior.
        //
        // The command is built as the generated `SurfaceCommand::StartSession`
        // (mirrored from the zod `SurfaceCommandSchema`) and serialized via serde,
        // so absent optionals are OMITTED — exactly what the sidecar's zod
        // `.optional()` validation accepts. The wire keys are the contract's
        // camelCase; the typed enums reject any out-of-contract value here.
        let command = SurfaceCommand::StartSession {
            prompt,
            model,
            effort: match effort {
                Some(e) => Some(parse_wire_enum::<EffortLevel>("effort", &e)?),
                None => None,
            },
            permission_mode: match permission_mode {
                Some(m) => Some(parse_wire_enum::<WirePermissionMode>("permissionMode", &m)?),
                None => None,
            },
            cwd: cwd.map(|p| p.to_string_lossy().to_string()),
            kind: Some(parse_wire_enum::<WireTaskKind>("kind", kind)?),
            max_turns: guardrails.max_turns.map(u64::from),
            max_budget_usd: guardrails.max_budget_usd,
            resume_session_id: guardrails.resume_session_id,
            // Enabled external MCP servers (resolved project→global by the settings
            // store). An empty list serializes as an OMITTED field — byte-identical
            // to the pre-feature `start-session` — so injecting none changes nothing.
            mcp_servers: (!guardrails.mcp_servers.is_empty()).then_some(guardrails.mcp_servers),
            // Pre-flight Context Pack (Lock, feature #4): the curated Constitution to
            // compose into the SDK `appendSystemPrompt`. `None` serializes as an
            // OMITTED field — byte-identical to the pre-feature `start-session`.
            append_context_pack: guardrails.append_context_pack,
        };
        let command = serde_json::to_value(&command).map_err(|e| e.to_string())?;

        // Push the pending launch and write the line under the same lock so the
        // FIFO can't be reordered against the wire by a concurrent launch.
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or("sidecar stdin unavailable")?;
        self.push_pending(task_id);
        if let Err(e) = Self::write_line(stdin, &command).await {
            // The write failed: undo the pending push we just made so it can't
            // mis-correlate a later session.
            crate::sync::lock_or_recover(&self.correlation)
                .pending
                .pop_back();
            return Err(e);
        }
        Ok(())
    }

    async fn interrupt(&self, session_id: u64) -> Result<(), String> {
        let command = serde_json::to_value(SurfaceCommand::Interrupt { session_id })
            .map_err(|e| e.to_string())?;
        let mut guard = self.stdin.lock().await;
        if let Some(stdin) = guard.as_mut() {
            Self::write_line(stdin, &command).await?;
        }
        Ok(())
    }

    async fn set_permission_mode(&self, session_id: u64, mode: &str) -> Result<(), String> {
        let command = serde_json::to_value(SurfaceCommand::SetPermissionMode {
            session_id,
            mode: parse_wire_enum::<WirePermissionMode>("mode", mode)?,
        })
        .map_err(|e| e.to_string())?;
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
        // Map the core decision onto the generated wire `PermissionDecision`. The
        // engine echoes the parked input when `updatedInput` is omitted, so a bare
        // allow stays bare (serde omits the `None`); it is included only when the
        // surface rewrote the input. The contract types `updatedInput` as a JSON
        // object (`z.record`), so a non-object rewrite is a contract violation.
        let wire_decision = match decision {
            PermissionDecision::Allow {
                updated_input: None,
            } => WirePermissionDecision::Allow {
                updated_input: None,
            },
            PermissionDecision::Allow {
                updated_input: Some(input),
            } => {
                let map = match input {
                    Value::Object(map) => map,
                    other => {
                        return Err(format!(
                            "updatedInput must be a JSON object per the contract, got: {other}"
                        ))
                    }
                };
                WirePermissionDecision::Allow {
                    updated_input: Some(map),
                }
            }
            PermissionDecision::Deny { message } => WirePermissionDecision::Deny { message },
        };
        let command = serde_json::to_value(SurfaceCommand::ApprovePermission {
            session_id,
            request_id: request_id.to_string(),
            decision: wire_decision,
        })
        .map_err(|e| e.to_string())?;
        let mut guard = self.stdin.lock().await;
        if let Some(stdin) = guard.as_mut() {
            Self::write_line(stdin, &command).await?;
        }
        Ok(())
    }

    async fn send_answer(
        &self,
        session_id: u64,
        request_id: &str,
        answer: AnswerQuestionAnswerUnion,
    ) -> Result<(), String> {
        // Pure passthrough: the wire union is already the shape the engine expects,
        // so (unlike decide_permission) there is no core→wire mapping step.
        let command = serde_json::to_value(SurfaceCommand::AnswerQuestion {
            session_id,
            request_id: request_id.to_string(),
            answer,
        })
        .map_err(|e| e.to_string())?;
        let mut guard = self.stdin.lock().await;
        if let Some(stdin) = guard.as_mut() {
            Self::write_line(stdin, &command).await?;
        }
        Ok(())
    }

    async fn query(&self, query: SurfaceQuery) -> Result<Value, String> {
        // Serialize the query, then OVERWRITE its `requestId` with a fresh uuid so
        // the caller can't collide two in-flight queries (and so the wire id is the
        // one we register the pending reply under).
        let mut payload = serde_json::to_value(&query).map_err(|e| e.to_string())?;
        let request_id = uuid::Uuid::new_v4().to_string();
        match payload.as_object_mut() {
            Some(map) => {
                map.insert("requestId".to_string(), Value::String(request_id.clone()));
            }
            None => return Err("query did not serialize to a JSON object".to_string()),
        }

        // Register the pending reply BEFORE writing, so a fast reply can't arrive
        // before the sender exists.
        let (tx, rx) = oneshot::channel::<Value>();
        crate::sync::lock_or_recover(&self.pending_replies).insert(request_id.clone(), tx);

        // Write the query line under the stdin lock. On a write failure, evict the
        // pending entry we just registered so it can't leak.
        let write_result = {
            let mut guard = self.stdin.lock().await;
            match guard.as_mut() {
                Some(stdin) => Self::write_line(stdin, &payload).await,
                None => Err("sidecar stdin unavailable".to_string()),
            }
        };
        if let Err(e) = write_result {
            crate::sync::lock_or_recover(&self.pending_replies).remove(&request_id);
            return Err(e);
        }

        // Await the correlated reply with a bound. On timeout/cancel, evict the
        // pending entry so it doesn't leak (the reader's later fulfill is a no-op).
        match tokio::time::timeout(QUERY_TIMEOUT, rx).await {
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err(_recv)) => {
                // The sender was dropped (e.g. sidecar crash reset) — no reply coming.
                Err("sidecar closed before the query reply arrived".to_string())
            }
            Err(_elapsed) => {
                crate::sync::lock_or_recover(&self.pending_replies).remove(&request_id);
                Err("timed out waiting for the session query reply".to_string())
            }
        }
    }

    fn correlate_reply(&self, request_id: &str, reply: Value) {
        let sender = crate::sync::lock_or_recover(&self.pending_replies).remove(request_id);
        match sender {
            Some(tx) => {
                // The receiver may have already timed out and dropped; a failed send
                // is fine (the entry is gone either way).
                let _ = tx.send(reply);
            }
            None => {
                tracing::debug!(target: "nightcore", request_id, "query-result for an unknown/expired request id; dropping");
            }
        }
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
    fn dev_build_spawns_bun_run_against_the_entry() {
        // The test harness is a debug build, so `spawn_command` must take the dev
        // path: `bun run <entry>`, with the entry TS file in the args (not the
        // compiled binary). This pins the release-packaging fix from regressing the
        // hot dev path.
        let p = provider();
        let cmd = p.spawn_command();
        let args: Vec<_> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(
            args.iter().any(|a| a == "run"),
            "dev spawn must invoke `bun run`: {args:?}"
        );
        assert!(
            args.iter().any(|a| a == "/tmp/entry.ts"),
            "dev spawn must target the TypeScript entry: {args:?}"
        );
    }

    #[test]
    fn release_sidecar_path_is_none_when_no_binary_is_bundled() {
        // No `nightcore-sidecar` is bundled next to the test runner, so the release
        // resolver must return None — which is what makes `spawn_command` fall back
        // to `bun run` instead of dead-ending on a missing binary.
        assert!(
            SidecarProvider::release_sidecar_path().is_none(),
            "no bundled sidecar exists next to the test binary"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn detects_a_macos_app_bundle_exe() {
        use std::path::Path;
        // A release bundle and a `tauri build --debug` bundle both put the exe inside
        // a `.app` — both must be treated as bundled so the sidecar binary is used.
        assert!(SidecarProvider::exe_in_app_bundle(Path::new(
            "/Applications/Nightcore.app/Contents/MacOS/nightcore"
        )));
        assert!(
            SidecarProvider::exe_in_app_bundle(Path::new(
                "/repo/apps/desktop/src-tauri/target/debug/bundle/macos/Nightcore.app/Contents/MacOS/nightcore"
            )),
            "a debug bundle under target/debug is still an .app bundle — must use the bundled sidecar"
        );
        // `tauri dev` runs the raw target binary — NOT a bundle, so it falls through
        // to `bun run` for hot reload.
        assert!(!SidecarProvider::exe_in_app_bundle(Path::new(
            "/repo/apps/desktop/src-tauri/target/debug/nightcore"
        )));
    }

    #[test]
    fn parse_line_skips_blanks_and_reports_bad_json() {
        assert!(parse_line("   ").is_none());
        assert!(parse_line(r#"{"type":"x"}"#).unwrap().is_ok());
        assert!(parse_line("{not json").unwrap().is_err());
    }

    #[tokio::test]
    async fn correlate_reply_fulfills_a_pending_query() {
        // A query registers a pending one-shot under its request id; the reader's
        // `correlate_reply` delivers the matching reply to the awaiting receiver.
        let p = provider();
        let (tx, rx) = oneshot::channel::<Value>();
        p.pending_replies
            .lock()
            .unwrap()
            .insert("req-1".to_string(), tx);

        p.correlate_reply("req-1", serde_json::json!({"ok": true}));
        let reply = rx.await.expect("the pending sender delivered the reply");
        assert_eq!(reply, serde_json::json!({"ok": true}));
        // The entry is consumed, so a second correlate is a no-op.
        assert!(p.pending_replies.lock().unwrap().is_empty());
    }

    #[test]
    fn correlate_reply_for_unknown_id_is_a_noop() {
        // A `query-result` whose request id has no pending entry (timed out, or a
        // stray reply) is dropped without panicking.
        let p = provider();
        p.correlate_reply("ghost", serde_json::json!({"ok": false}));
        assert!(p.pending_replies.lock().unwrap().is_empty());
    }
}
