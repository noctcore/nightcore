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
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;
use tokio::process::ChildStdin;
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;

use crate::contracts::{AnswerQuestionAnswerUnion, SurfaceQuery, WireImage};

mod correlation;
mod imp;
mod spawn;

// Glob-reexport facade so external `provider::*` call sites resolve unchanged after
// the split (mirrors `sidecar/mod.rs`). `correlation`/`spawn` carry only inherent
// `impl SidecarProvider` methods — no free items to re-export yet — so they're
// `allow(unused_imports)`; `imp` re-exports `parse_line`.
#[allow(unused_imports)]
pub use correlation::*;
pub use imp::*;
#[allow(unused_imports)]
pub use spawn::*;

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
        images: Vec<WireImage>,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> SidecarProvider {
        SidecarProvider::new(PathBuf::from("/tmp/entry.ts"), PathBuf::from("/tmp"))
    }

    // Session↔task correlation behaviors are unit-tested co-located with their code
    // in `correlation.rs`; the tests below cover the spawn resolver (`spawn.rs`) and
    // the line parser / query-reply plumbing (`imp.rs`).

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
