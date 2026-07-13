//! The `impl Provider for SidecarProvider` block, the core command-writing
//! inherent methods (construct / dispatch / write), and the shared NDJSON line
//! parser.

use super::*;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;

use crate::contracts::{
    AnswerQuestionAnswerUnion, AutonomyLevel, EffortLevel,
    PermissionDecision as WirePermissionDecision, SurfaceCommand, SurfaceQuery,
    TaskKind as WireTaskKind, WireImage,
};

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

impl SidecarProvider {
    /// A provider that will spawn the sidecar in `cwd` on first use. In debug
    /// builds (`tauri dev`) this is `bun run <entry>` against the TypeScript source;
    /// in release builds it is the compiled binary bundled next to the app.
    ///
    /// `provider_id` is threaded to the sidecar via the `NIGHTCORE_PROVIDER` env
    /// override so the engine-side factory selects the implementation (issue #18);
    /// it is the SAME transport for every provider today (one Bun sidecar, no second
    /// binary in the spike).
    pub fn new(entry: PathBuf, cwd: PathBuf, provider_id: String) -> Self {
        Self {
            stdin: AsyncMutex::new(None),
            correlation: Mutex::new(Correlation::default()),
            pending_replies: Mutex::new(HashMap::new()),
            entry,
            cwd,
            provider_id,
        }
    }

    /// Whether the child has been spawned. (Diagnostic accessor for a future
    /// health/status command; `spawn` is idempotent so callers don't need it.)
    #[allow(dead_code)]
    pub async fn is_running(&self) -> bool {
        self.stdin.lock().await.is_some()
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
        provider_id: Option<String>,
        model: Option<String>,
        effort: Option<String>,
        cwd: Option<PathBuf>,
        autonomy: Option<AutonomyLevel>,
        kind: &str,
        images: Vec<WireImage>,
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
            provider_id,
            model,
            effort: match effort {
                Some(e) => Some(parse_wire_enum::<EffortLevel>("effort", &e)?),
                None => None,
            },
            // `autonomy` is already the typed neutral enum (parsed at the settings
            // resolver boundary), so it travels the wire as-is; the engine lowers it
            // to an SDK permission mode inside the Claude provider.
            autonomy,
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
            // Harness runtime policy (hardening module #3): the manifest-declared
            // protected paths + Bash deny patterns the engine's PreToolUse gate
            // enforces. `None` serializes as an OMITTED field — byte-identical to
            // the pre-feature `start-session` (no policy layer).
            harness_policy: guardrails.harness_policy,
            // Session flight recorder (module #5): the per-task tool-event ledger
            // path the engine appends to. `None` serializes as an OMITTED field —
            // byte-identical to the pre-feature `start-session` (no recording).
            ledger_path: guardrails.ledger_path,
            // OS write containment (hardening module #15): opt-in Seatbelt
            // wrapping of the session's `claude` on the engine side. `false`
            // serializes as an OMITTED field — byte-identical to the
            // pre-feature `start-session`.
            sandbox_writes: guardrails.sandbox_writes.then_some(true),
            // Task image attachments → SDK image content blocks. An empty list
            // serializes as an OMITTED field — byte-identical to the pre-feature
            // `start-session` (a text-only user message).
            images: (!images.is_empty()).then_some(images),
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

    async fn stream_input(&self, session_id: u64, text: String) -> Result<(), String> {
        // Fire-and-forget, exactly like `interrupt`: the `send-input` SurfaceCommand
        // is routed to the session by `sessionId`, and the runner enqueues `text` as
        // the next user turn. No pending-launch FIFO push (this is not a session
        // start) and no correlated reply. `text` is user content — never logged.
        let command = serde_json::to_value(SurfaceCommand::SendInput { session_id, text })
            .map_err(|e| e.to_string())?;
        let mut guard = self.stdin.lock().await;
        if let Some(stdin) = guard.as_mut() {
            Self::write_line(stdin, &command).await?;
        }
        Ok(())
    }

    async fn set_autonomy(&self, session_id: u64, autonomy: AutonomyLevel) -> Result<(), String> {
        let command = serde_json::to_value(SurfaceCommand::SetAutonomy {
            session_id,
            autonomy,
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
