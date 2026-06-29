//! The `#[tauri::command]` entry points for the sidecar: the manual `run_task`
//! single-run path, `cancel_task`, the `respond_permission` relay, and the
//! command-only helpers (`resolve_permission_mode`, `build_guardrails`) shared with
//! the coordinator's auto-loop launch.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::contracts::AnswerQuestionAnswerUnion;
use crate::engine_api::EngineApi;
use crate::provider::{PermissionDecision, Provider, SidecarProvider};
use crate::project::ProjectStore;
use crate::store::TaskStore;
use crate::task::Task;

/// Run a task through the sidecar — the manual single-run path (still useful with
/// the loop). Leases a slot (the generalization of M1's serial guard: a free slot
/// must exist at the configured concurrency), allocates a worktree, marks the task
/// `in_progress`, ensures the sidecar is up, then dispatches `start-session`.
/// Streaming and the terminal transition happen on the reader task.
///
/// The whole ordered sequence lives in the engine's `submit_run` (behind
/// [`EngineApi`]), shared with the auto-loop `launch`. A manual run feeds NO circuit
/// breaker (`feed_breaker = false`) and surfaces the setup error to the caller as
/// its `Result`; the auto-loop launch feeds the breaker and discards the result.
#[tauri::command]
pub async fn run_task(app: AppHandle, id: String) -> Result<(), String> {
    let engine = app.state::<Arc<dyn EngineApi>>();
    engine.submit_run(&app, &id, false).await
}

/// The SDK permission mode for the next run (M4.7 §A4). Precedence:
///   task override → project override → global default.
/// `task_override` is the task's own `permission_mode` (a UI string like `bypass`/
/// `ask`); when present it wins and is mapped through the same
/// [`crate::settings::sdk_permission_mode`] table so a task can opt OUT of global
/// bypass. Absent ⇒ fall back to the settings resolution (project, else global).
/// Shared by the manual `run_task` path and the coordinator's auto-loop launch.
pub fn resolve_permission_mode(app: &AppHandle, task_override: Option<&str>) -> Option<String> {
    use crate::settings::{sdk_permission_mode, SettingsStore};
    if let Some(raw) = task_override {
        return Some(sdk_permission_mode(raw));
    }
    let settings = app.state::<SettingsStore>();
    let project_id = app.state::<ProjectStore>().active().map(|p| p.id);
    Some(settings.sdk_permission_mode(project_id.as_deref()))
}

/// Build the per-session `start-session` config for a build run from its task: the
/// per-task autonomy ceilings (`max_turns`/`max_budget_usd`; `None` ⇒ the engine
/// inherits the `@nightcore/config` default), the resume id (the persisted SDK
/// session UUID → engine `Options.resume`) so a crashed/restarted build reattaches
/// instead of starting cold, and the resolved enabled external MCP servers
/// (`resolve_mcp_servers`). Reviewer/fix sub-runs build their own [`Guardrails`]
/// inline (ceilings inherited, never resumed) but resolve the SAME MCP list.
pub fn build_guardrails(app: &AppHandle, task: &Task) -> crate::provider::Guardrails {
    crate::provider::Guardrails {
        max_turns: task.max_turns,
        max_budget_usd: task.max_budget_usd,
        resume_session_id: task.sdk_session_id.clone(),
        mcp_servers: resolve_mcp_servers(app),
        append_context_pack: resolve_context_pack(app),
    }
}

/// The Pre-flight Context Pack (Lock, feature #4) to inject for a run in the active
/// project: the curated `<project>/.nightcore/context.md`, gated on the per-project
/// `context_pack_enabled` toggle (project-override → global, the SAME precedence
/// `resolve_permission_mode`/`resolve_mcp_servers` use). `None` when no project is
/// active, the toggle is off, or no `context.md` exists — each yielding the
/// pre-feature shape (no pack injected). Shared by the build path, reviewer, and
/// fix sub-runs so every session in a project starts on the same rails.
pub fn resolve_context_pack(app: &AppHandle) -> Option<String> {
    use crate::settings::SettingsStore;
    let project = app.state::<ProjectStore>().active()?;
    let settings = app.state::<SettingsStore>();
    if !settings.context_pack_enabled(Some(&project.id)) {
        return None;
    }
    crate::store::context::read_pack(&project.path)
}

/// The enabled external MCP servers to inject for a run in the active project,
/// resolved project-override → global by the settings store (the SAME
/// project→global precedence `resolve_permission_mode` uses). Only enabled entries
/// are returned; an empty list ⇒ inject none. Shared by the manual `run_task` path,
/// the coordinator auto-loop launch, and the reviewer/fix sub-runs so every session
/// in a project sees the same configured servers.
pub fn resolve_mcp_servers(app: &AppHandle) -> Vec<crate::contracts::McpServerEntry> {
    use crate::settings::SettingsStore;
    let settings = app.state::<SettingsStore>();
    let project_id = app.state::<ProjectStore>().active().map(|p| p.id);
    settings
        .enabled_mcp_servers(project_id.as_deref())
        .into_iter()
        .map(Into::into)
        .collect()
}

/// Respond to a parked interactive permission request (M3 §B). `decision` is
/// `"allow"` or `"deny"`. An allow may carry `updated_input` to rewrite the tool
/// input (the engine echoes the original when omitted); a deny carries an optional
/// `message` returned to the model. Resolves the request in the registry and sends
/// the `approve-permission` SurfaceCommand to the sidecar. Fail-closed: an unknown
/// `decision` is treated as a deny.
#[tauri::command]
pub async fn respond_permission(
    app: AppHandle,
    store: State<'_, TaskStore>,
    provider: State<'_, Arc<SidecarProvider>>,
    engine: State<'_, Arc<dyn EngineApi>>,
    task_id: String,
    request_id: String,
    decision: String,
    updated_input: Option<Value>,
    message: Option<String>,
) -> Result<(), String> {
    let session_id = provider
        .session_for(&task_id)
        .or_else(|| store.get(&task_id).and_then(|t| t.session_id))
        .ok_or_else(|| format!("no live session for task {task_id}"))?;

    // Drop it from the parked set regardless; a stale/duplicate decision is a no-op.
    engine.permissions_resolve(&app, &task_id, &request_id);

    let allow = decision == "allow";
    let decision = match decision.as_str() {
        "allow" => PermissionDecision::Allow { updated_input },
        _ => PermissionDecision::Deny {
            message: message.unwrap_or_else(|| "Denied by user.".to_string()),
        },
    };
    // Decision is debug-only (the surface's choice, never the tool input).
    tracing::debug!(target: "nightcore", task_id, session_id, allow, "permission decision sent");
    provider
        .decide_permission(session_id, &request_id, decision)
        .await
}

/// Answer a parked `AskUserQuestion` dialog (the desktop board's reply to an
/// `nc:question` prompt). `answer` is the wire union — `{behavior:"answer", answers}`
/// to submit the user's choices, or `{behavior:"cancel"}` to skip. Resolves to the
/// live session and forwards an `answer-question` SurfaceCommand to the sidecar. The
/// answer content (user text) is never logged.
#[tauri::command]
pub async fn answer_question(
    store: State<'_, TaskStore>,
    provider: State<'_, Arc<SidecarProvider>>,
    task_id: String,
    request_id: String,
    answer: AnswerQuestionAnswerUnion,
) -> Result<(), String> {
    let session_id = provider
        .session_for(&task_id)
        .or_else(|| store.get(&task_id).and_then(|t| t.session_id))
        .ok_or_else(|| format!("no live session for task {task_id}"))?;

    tracing::debug!(target: "nightcore", task_id, session_id, "ask-user-question answer sent");
    provider
        .send_answer(session_id, &request_id, answer)
        .await
}

/// Best-effort interrupt of a task's run. Aborts the slot's driver (if the loop
/// spawned one) and sends an `interrupt` for the task's session; the terminal
/// transition still arrives via the sidecar's `session-failed (aborted)` event,
/// which releases the slot.
#[tauri::command]
pub async fn cancel_task(
    app: AppHandle,
    store: State<'_, TaskStore>,
    provider: State<'_, Arc<SidecarProvider>>,
    engine: State<'_, Arc<dyn EngineApi>>,
    id: String,
) -> Result<(), String> {
    // Fail-closed: deny any permission request parked for this task before the
    // interrupt, so a session waiting on an approval can't hang.
    engine.deny_parked_permissions(&app, &id).await;

    // Prefer the live correlation binding (set the moment the run started); fall
    // back to the persisted session id from a prior run.
    let session_id = provider
        .session_for(&id)
        .or_else(|| store.get(&id).and_then(|t| t.session_id));
    if let Some(session_id) = session_id {
        // KEEP the slot leased. The interrupt produces a terminal
        // `session-failed { reason: "aborted" }`, whose `finish_run` releases the slot
        // exactly once. Freeing it here (the old `slots_abort`) instead let an immediate
        // re-run lease the slot before this run's terminal arrived — after which the
        // stale terminal clobbered the new run's state and released ITS slot, launching
        // past `max_concurrency`. Holding the lease until the terminal serializes
        // cancel → re-run so the re-run is simply refused until this run settles.
        provider.interrupt(session_id).await?;
    } else {
        // No correlated session yet: no terminal will ever arrive to release the slot,
        // so free it here. Evict the pending launch (concurrency #5) so a later,
        // unrelated session can't mis-bind to this cancelled launch.
        engine.slots_release(&app, &id);
        provider.evict_pending(&id);
    }
    Ok(())
}
