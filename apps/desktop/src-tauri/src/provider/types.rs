//! The provider seam's types: the [`Provider`] trait, the `start-session`
//! [`Guardrails`], the [`PermissionDecision`], and the concrete [`SidecarProvider`]
//! + its [`Correlation`] / [`SidecarStreams`] state.
//!
//! Lifted out of `provider/mod.rs` into this sibling so the module stays a manifest
//! (issue #17 phase D). The `imp`/`correlation`/`spawn` sibling impls reach these
//! via `use super::*`; `SidecarProvider`/`Correlation` fields are `pub(super)` so
//! those descendants keep accessing them.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;
use tokio::process::ChildStdin;
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;

use crate::contracts::{AnswerQuestionAnswerUnion, SurfaceQuery, WireImage};

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
    // Deliberate provider-seam API (the multi-provider override point described above);
    // the inspector command currently issues the query directly, so no caller yet.
    #[allow(dead_code)]
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
    /// Harness runtime policy (hardening module #3): the `policy` key of
    /// `<project>/.nightcore/harness.json`, resolved by
    /// [`crate::store::harness_policy::read_policy`] → engine `harnessPolicy` →
    /// enforced by the engine's PreToolUse gate (protected paths + Bash deny
    /// patterns), which holds even under `bypassPermissions`. `None` ⇒ no policy
    /// layer (no manifest, or `policy.enabled: false` — the pre-feature shape).
    pub harness_policy: Option<crate::contracts::HarnessPolicy>,
    /// Session flight recorder (module #5): the per-task NDJSON tool-event
    /// ledger path, computed by [`crate::store::ledger::ledger_path`] from the
    /// SAME project root `harness_policy` resolves from (never the worktree
    /// cwd) → engine `ledgerPath` → one appended record per PreToolUse gate
    /// evaluation. `None` ⇒ no recording (no project root — the pre-feature
    /// shape).
    pub ledger_path: Option<String>,
    /// OS write containment (hardening module #15): whether the engine wraps the
    /// session's `claude` in a Seatbelt deny-write-except profile → engine
    /// `sandboxWrites`. Resolved from the GLOBAL `sandbox_sessions` setting.
    /// `false` ⇒ the field is omitted on the wire (the pre-feature shape). The
    /// engine applies it only where the host supports it (darwin) and warns +
    /// runs unwrapped otherwise (fail-open; experimental, default-off).
    pub sandbox_writes: bool,
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
/// `AppHandle` to emit events; this struct owns only the protocol plumbing. Fields
/// are `pub(super)` so the sibling `imp`/`correlation`/`spawn` impls reach them.
pub struct SidecarProvider {
    pub(super) stdin: AsyncMutex<Option<ChildStdin>>,
    /// `Some(stdout)` exactly once, after `spawn`, handed to the reader installer.
    pub(super) correlation: Mutex<Correlation>,
    /// Pending session-query replies, keyed by the `requestId` written on the wire.
    /// The query awaits its one-shot; the reader fulfills it from a `query-result`
    /// event. Separate from `correlation` (sessions↔tasks) — a query has no session.
    pub(super) pending_replies: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    pub(super) entry: PathBuf,
    pub(super) cwd: PathBuf,
}

/// Session↔task correlation: the live `sessionId → taskId` map plus the
/// pending-launch FIFO of task ids awaiting their first `session-started`. Also
/// records when each session was first correlated, so a terminal can log the run's
/// wall-clock `duration_ms` (observability #5).
#[derive(Default)]
pub(super) struct Correlation {
    pub(super) by_session: HashMap<u64, String>,
    pub(super) pending: VecDeque<String>,
    pub(super) started_at: HashMap<u64, std::time::Instant>,
}
