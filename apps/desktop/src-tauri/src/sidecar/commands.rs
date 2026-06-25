//! The `#[tauri::command]` entry points for the sidecar: the manual `run_task`
//! single-run path, `cancel_task`, the `respond_permission` relay, and the
//! command-only helpers (`resolve_permission_mode`, `build_guardrails`) shared with
//! the coordinator's auto-loop launch.

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::contracts::AnswerQuestionAnswerUnion;
use crate::m2::coordinator::{self, Orchestrator};
use crate::m2::provider::{PermissionDecision, Provider};
use crate::m2::worktree;
use crate::project::ProjectStore;
use crate::store::TaskStore;
use crate::task::Task;

use super::ensure_reader;

/// Run a task through the sidecar — the manual single-run path (still useful with
/// the loop). Leases a slot (the generalization of M1's serial guard: a free slot
/// must exist at the configured concurrency), allocates a worktree, marks the task
/// `in_progress`, ensures the sidecar is up, then dispatches `start-session`.
/// Streaming and the terminal transition happen on the reader task.
#[tauri::command]
pub async fn run_task(
    app: AppHandle,
    store: State<'_, TaskStore>,
    orch: State<'_, Orchestrator>,
    id: String,
) -> Result<(), String> {
    let task = store
        .get(&id)
        .ok_or_else(|| format!("no task with id {id}"))?;

    // Lease a slot. With concurrency 1 this reproduces M1's "a task is already
    // running" rejection exactly.
    if !orch.slots.try_lease(&id) {
        return Err("no free slot (max concurrency reached)".to_string());
    }

    // Resolve the run cwd off the active project + run mode (shared with the
    // auto-loop `launch` so the manual and automatic paths run identically).
    let resolved = match coordinator::resolve_worktree(&app, &id) {
        Ok(cwd) => cwd,
        Err(e) => {
            orch.slots.release(&id);
            return Err(e);
        }
    };
    // Worktree mode carries a `nc/<taskId>` branch chip; main mode runs in the
    // project root on the current branch (no chip).
    let is_worktree = resolved.as_ref().map(|r| r.is_worktree).unwrap_or(false);
    let cwd = resolved.map(|r| r.path);
    let branch = is_worktree.then(|| worktree::branch_name(&id));

    // Mark in-progress + persist + emit before dispatch (shared with `launch`).
    if let Err(e) = coordinator::mark_task_in_progress(&app, &id, branch.clone()) {
        orch.slots.release(&id);
        return Err(e);
    }

    if let Err(e) = ensure_reader(&app).await {
        // Reset to Failed so the task doesn't strand in InProgress with no log
        // (shared `fail_task` marks + emits; a manual run does NOT feed the breaker).
        coordinator::fail_task(&app, &id, &e);
        orch.slots.release(&id);
        return Err(e);
    }

    let permission_mode = resolve_permission_mode(&app, task.permission_mode.as_deref());
    // SDK-guardrails: a manual re-run is a build launch — forward the ceilings,
    // resume the persisted SDK session id when present (recovery path), and inject
    // the project's enabled MCP servers.
    let guardrails = build_guardrails(&app, &task);
    if let Err(e) = orch
        .provider
        .start_session(
            &id,
            task.prompt(),
            task.model.clone(),
            task.effort.clone(),
            cwd,
            permission_mode,
            task.kind.as_wire(),
            guardrails,
        )
        .await
    {
        orch.slots.release(&id);
        return Err(e);
    }

    Ok(())
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
pub fn build_guardrails(app: &AppHandle, task: &Task) -> crate::m2::provider::Guardrails {
    crate::m2::provider::Guardrails {
        max_turns: task.max_turns,
        max_budget_usd: task.max_budget_usd,
        resume_session_id: task.sdk_session_id.clone(),
        mcp_servers: resolve_mcp_servers(app),
    }
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
    store: State<'_, TaskStore>,
    orch: State<'_, Orchestrator>,
    task_id: String,
    request_id: String,
    decision: String,
    updated_input: Option<Value>,
    message: Option<String>,
) -> Result<(), String> {
    let session_id = orch
        .provider
        .session_for(&task_id)
        .or_else(|| store.get(&task_id).and_then(|t| t.session_id))
        .ok_or_else(|| format!("no live session for task {task_id}"))?;

    // Drop it from the parked set regardless; a stale/duplicate decision is a no-op.
    orch.permissions.resolve(&task_id, &request_id);

    let allow = decision == "allow";
    let decision = match decision.as_str() {
        "allow" => PermissionDecision::Allow { updated_input },
        _ => PermissionDecision::Deny {
            message: message.unwrap_or_else(|| "Denied by user.".to_string()),
        },
    };
    // Decision is debug-only (the surface's choice, never the tool input).
    tracing::debug!(target: "nightcore", task_id, session_id, allow, "permission decision sent");
    orch.provider
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
    orch: State<'_, Orchestrator>,
    task_id: String,
    request_id: String,
    answer: AnswerQuestionAnswerUnion,
) -> Result<(), String> {
    let session_id = orch
        .provider
        .session_for(&task_id)
        .or_else(|| store.get(&task_id).and_then(|t| t.session_id))
        .ok_or_else(|| format!("no live session for task {task_id}"))?;

    tracing::debug!(target: "nightcore", task_id, session_id, "ask-user-question answer sent");
    orch.provider
        .send_answer(session_id, &request_id, answer)
        .await
}

/// Best-effort interrupt of a task's run. Aborts the slot's driver (if the loop
/// spawned one) and sends an `interrupt` for the task's session; the terminal
/// transition still arrives via the sidecar's `session-failed (aborted)` event,
/// which releases the slot.
#[tauri::command]
pub async fn cancel_task(
    store: State<'_, TaskStore>,
    orch: State<'_, Orchestrator>,
    id: String,
) -> Result<(), String> {
    // Abort the driver task (no-op if none attached) but keep the slot until the
    // terminal event so the reader's cleanup runs exactly once.
    orch.slots.abort(&id);

    // Fail-closed: deny any permission request parked for this task before the
    // interrupt, so a session waiting on an approval can't hang.
    orch.deny_parked_permissions(&id).await;

    // Prefer the live correlation binding (set the moment the run started); fall
    // back to the persisted session id from a prior run.
    let session_id = orch
        .provider
        .session_for(&id)
        .or_else(|| store.get(&id).and_then(|t| t.session_id));
    if let Some(session_id) = session_id {
        orch.provider.interrupt(session_id).await?;
    } else {
        // No correlated session yet: the launch may be pending its first
        // `session-started`. Evict that pending entry (concurrency #5) so a later,
        // unrelated session can't mis-bind to this cancelled launch.
        orch.provider.evict_pending(&id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::m2::slots::SlotManager;

    /// The M1 serial guard, now expressed through the slot manager at max=1:
    /// `run_task` rejects with no free slot whenever one is held. (The full command
    /// needs an `AppHandle` we can't build in a unit test; the decision is purely
    /// `SlotManager::try_lease`.)
    #[test]
    fn serial_guard_is_max_one_slot() {
        let slots = SlotManager::new(1);
        assert!(slots.try_lease("task-1"), "first run claims the slot");
        assert!(
            !slots.try_lease("task-2"),
            "a second run is refused while one holds the only slot"
        );
        slots.release("task-1");
        assert!(slots.try_lease("task-2"), "freed slot admits the next run");
    }

    /// A terminal event releases the slot, letting the next run pass the guard —
    /// the M2 equivalent of M1's `set_active(None)` on completion.
    #[test]
    fn terminal_event_frees_the_slot() {
        let slots = SlotManager::new(1);
        slots.try_lease("task-1");
        assert_eq!(slots.free_slots(), 0);
        slots.release("task-1"); // finish_run does this on a terminal event
        assert_eq!(slots.free_slots(), 1);
    }
}
