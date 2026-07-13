//! The `#[tauri::command]` entry points for the sidecar: the manual `run_task`
//! single-run path, `cancel_task`, the `respond_permission` relay, and the
//! command-only helpers (`resolve_autonomy`, `build_guardrails`) shared with
//! the coordinator's auto-loop launch.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::contracts::AnswerQuestionAnswerUnion;
use crate::engine_api::EngineApi;
use crate::project::ProjectStore;
use crate::provider::{PermissionDecision, Provider, SidecarProvider};
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

/// The neutral autonomy ceiling for the next run (issue #18, Phase 3). Precedence:
///   task override → project override → global default.
/// `task_override` is the task's own `permission_mode` (a neutral value like
/// `bypass`/`ask`); when present it wins and is parsed through the same
/// [`crate::settings::parse_autonomy`] table so a task can opt OUT of global bypass.
/// Absent ⇒ fall back to the settings resolution (project, else global). The value
/// travels the wire as-is; the Claude provider lowers it to an SDK permission mode.
/// Shared by the manual `run_task` path and the coordinator's auto-loop launch.
pub fn resolve_autonomy(
    app: &AppHandle,
    task_override: Option<&str>,
) -> Option<crate::contracts::AutonomyLevel> {
    use crate::settings::{parse_autonomy, SettingsStore};
    if let Some(raw) = task_override {
        return Some(parse_autonomy(raw));
    }
    let settings = app.state::<SettingsStore>();
    let project_id = app.state::<ProjectStore>().active().map(|p| p.id);
    Some(settings.autonomy(project_id.as_deref()))
}

/// Build the per-session `start-session` config for a build run from its task: the
/// per-task autonomy ceilings (`max_turns`/`max_budget_usd`; `None` ⇒ the engine
/// inherits the `@nightcore/config` default), the resume id (the persisted SDK
/// session UUID → engine `Options.resume`) so a crashed/restarted build reattaches
/// instead of starting cold, and the resolved enabled external MCP servers
/// (`resolve_mcp_servers`). Reviewer/fix sub-runs build their own [`Guardrails`]
/// inline (ceilings inherited, never resumed) but resolve the SAME MCP list.
pub fn build_guardrails(
    app: &AppHandle,
    task: &Task,
    project_root: Option<&std::path::Path>,
) -> crate::provider::Guardrails {
    // Resolve the enforcement root from the project root the RUN CWD was
    // pinned to (threaded from `resolve_worktree`), NOT a fresh `active()`
    // read — so a project switch during the launch's sidecar-cold-start await
    // can't arm the wrong project's rails (or none) over this run. Falls back
    // to the active project only when the caller has no pinned root (there is
    // then no cwd/project mismatch to guard against). The harness policy AND
    // the flight-recorder ledger path both resolve from this SAME root: the
    // ledger lives beside the manifest, never in the worktree.
    let root: Option<std::path::PathBuf> = match project_root {
        Some(root) => Some(root.to_path_buf()),
        None => app
            .state::<ProjectStore>()
            .active()
            .map(|p| std::path::PathBuf::from(&p.path)),
    };
    crate::provider::Guardrails {
        max_turns: task.max_turns,
        max_budget_usd: task.max_budget_usd,
        resume_session_id: task.sdk_session_id.clone(),
        mcp_servers: resolve_mcp_servers(app),
        append_context_pack: resolve_context_pack(app),
        harness_policy: root
            .as_deref()
            .and_then(|r| crate::store::harness_policy::read_policy(&r.to_string_lossy())),
        ledger_path: root.as_deref().map(|r| {
            crate::store::ledger::ledger_path(r, &task.id)
                .to_string_lossy()
                .to_string()
        }),
        sandbox_writes: resolve_sandbox_writes(app),
    }
}

/// OS write containment (hardening module #15): whether sessions launch with the
/// engine's Seatbelt write-containment wrapper, from the GLOBAL `sandbox_sessions`
/// setting (no per-project override — like `auto_commit_on_verified`). The engine
/// applies it only where the host supports it (darwin with `sandbox-exec`);
/// elsewhere it logs a loud warning and runs unwrapped (fail-open). Shared by the
/// manual/auto build path and the reviewer/fix sub-runs so every session in a run
/// is contained the same way.
pub fn resolve_sandbox_writes(app: &AppHandle) -> bool {
    use crate::settings::SettingsStore;
    app.state::<SettingsStore>()
        .with_settings(|s| s.sandbox_sessions)
}

/// The harness runtime policy (hardening module #3) to arm for a run in the active
/// project: the `policy` key of `<project>/.nightcore/harness.json`, resolved by
/// [`crate::store::harness_policy::read_policy`]. `None` when no project is active,
/// no manifest exists, or the project disabled it (`policy.enabled: false`) — each
/// yielding the pre-feature shape (no policy layer armed). The manifest is the
/// opt-in itself, so there is no separate settings toggle. Used by the reviewer
/// and fix sub-runs (whose cwd is a caller-supplied worktree already pinned to
/// this project, with no cold-start await between the task read and this call);
/// the main build path threads the pinned project root through
/// [`build_guardrails`] instead, to close the wider launch-window race.
pub fn resolve_harness_policy(app: &AppHandle) -> Option<crate::contracts::HarnessPolicy> {
    let project = app.state::<ProjectStore>().active()?;
    crate::store::harness_policy::read_policy(&project.path)
}

/// The session flight-recorder ledger path (module #5) for a run of `task_id`
/// in the active project: `<project>/.nightcore/ledger/<task_id>.ndjson`, the
/// SAME project root the harness policy resolves from (never the worktree cwd),
/// so a task's build/reviewer/fix sessions all append to one file. `None` when
/// no project is active (no root to anchor the ledger — the engine then records
/// nothing). Used by the reviewer/fix sub-runs; the main build path derives the
/// path from its PINNED root inside [`build_guardrails`] instead.
pub fn resolve_ledger_path(app: &AppHandle, task_id: &str) -> Option<String> {
    let project = app.state::<ProjectStore>().active()?;
    Some(
        crate::store::ledger::ledger_path(std::path::Path::new(&project.path), task_id)
            .to_string_lossy()
            .to_string(),
    )
}

/// The Pre-flight Context Pack (Lock, feature #4) to inject for a run in the active
/// project: the curated `<project>/.nightcore/context.md`, gated on the per-project
/// `context_pack_enabled` toggle (project-override → global, the SAME precedence
/// `resolve_autonomy`/`resolve_mcp_servers` use). `None` when no project is
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
    crate::analysis::context::read_pack(&project.path)
}

/// The enabled external MCP servers to inject for a run in the active project,
/// resolved project-override → global by the settings store (the SAME
/// project→global precedence `resolve_autonomy` uses). Only enabled entries
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
// Tauri command surface: every arg is a wire field the web bridge passes by name;
// bundling them into a struct would churn the generated bridge for no safety win.
#[allow(clippy::too_many_arguments)]
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
    provider.send_answer(session_id, &request_id, answer).await
}

/// Resolve `task_id` to a session id the provider currently considers LIVE — the
/// same live-binding-then-persisted-fallback order `respond_permission`/
/// `answer_question` use, but with one extra check the fire-and-forget relays don't
/// need: the persisted fallback is validated against [`SidecarProvider::live_sessions`]
/// before it's trusted. A `task_id` whose ONLY binding left is a stale
/// `store`-persisted `session_id` (the live correlation forgot it — e.g. a sidecar
/// crash reset, or the session simply already ended) would otherwise resolve to a
/// session id the sidecar no longer recognizes, which it drops on the floor with no
/// signal back. `send_input` is the one caller that must not let that happen
/// silently — a chat message the user believes was sent has to either arrive or
/// bubble a toast.
fn resolve_live_session(
    provider: &SidecarProvider,
    store: &TaskStore,
    task_id: &str,
) -> Result<u64, String> {
    let session_id = provider
        .session_for(task_id)
        .or_else(|| store.get(task_id).and_then(|t| t.session_id))
        .ok_or_else(|| format!("no live session for task {task_id}"))?;

    if !provider.live_sessions().contains(&session_id) {
        return Err(format!(
            "session {session_id} for task {task_id} is no longer live; message was not delivered"
        ));
    }
    Ok(session_id)
}

/// Stream a user message into a task's LIVE running session — the sanctioned
/// human→running-agent chat path (`send-input`). Resolves the task's live session
/// id via [`resolve_live_session`] and forwards a `send-input` SurfaceCommand to the
/// sidecar, where the session runner enqueues it as the next user turn.
///
/// This is a USER-gesture-driven webview command ONLY (the composer's send/broadcast
/// action) — the SANCTIONED path for a human to talk to a running agent. It is never
/// wired to any agent-reachable/event surface (real PTY terminals stay user-only and
/// agent-inaccessible; this is the deliberate exception FOR the human, not the agent).
/// Async like its `answer_question`/`respond_permission` siblings: the write is fully
/// async tokio I/O, so it never blocks the WKWebView. The `text` is user content and
/// is never logged.
#[tauri::command]
pub async fn send_input(
    store: State<'_, TaskStore>,
    provider: State<'_, Arc<SidecarProvider>>,
    task_id: String,
    text: String,
) -> Result<(), String> {
    let session_id = resolve_live_session(&provider, &store, &task_id)?;

    tracing::debug!(target: "nightcore", task_id, session_id, "send-input relayed to session");
    provider.stream_input(session_id, text).await
}

/// Start a governed Council debate run (issue #350). Ensures the sidecar is up, then
/// dispatches a `start-council` SurfaceCommand to the engine, whose Conductor drives
/// the `Frame → Propose(blind) → Debate(≤2) → Converge(human)` state machine over the
/// preset's seats — the sole bus writer, so seats have zero agent-to-agent authority
/// (safety #1). Fire-and-forget: the run + its append-only transcript live in the
/// engine; the `nc:debate` transcript stream is the canvas slice (#352), so this
/// command only STARTS the run.
///
/// Async like its `send_input`/`respond_permission` siblings — the write is fully
/// async tokio I/O, so it never blocks the WKWebView. `objective` is user content and
/// is never logged.
#[tauri::command]
pub async fn start_council(
    app: AppHandle,
    provider: State<'_, Arc<SidecarProvider>>,
    run_id: String,
    preset_id: crate::contracts::CouncilPresetId,
    objective: String,
    project_path: Option<String>,
) -> Result<(), String> {
    crate::sidecar::ensure_reader(&app).await?;
    tracing::debug!(target: "nightcore", run_id, "start-council dispatched to engine");
    let command = crate::contracts::SurfaceCommand::StartCouncil {
        run_id,
        preset_id,
        objective,
        project_path,
    };
    provider.dispatch_command(command).await
}

/// Kill a running Council debate run immediately (safety non-negotiable #4 — the kill
/// switch; never "run until they agree"). Best-effort: when the sidecar is up, dispatch
/// a `kill-council` SurfaceCommand — the engine's Conductor throws the run's kill switch,
/// halting turn-taking at the next checkpoint and aborting the in-flight seat turn. When
/// the sidecar isn't running there is no live run to kill, so this is a no-op. Async like
/// its siblings.
#[tauri::command]
pub async fn kill_council(
    provider: State<'_, Arc<SidecarProvider>>,
    run_id: String,
) -> Result<(), String> {
    if !provider.is_running().await {
        return Ok(());
    }
    tracing::debug!(target: "nightcore", run_id, "kill-council dispatched to engine");
    let command = crate::contracts::SurfaceCommand::KillCouncil { run_id };
    provider.dispatch_command(command).await
}

/// Resolve a Council run's PARKED Converge decision with the human judge's verdict
/// (issue #353, safety non-negotiable #7 — the human is the terminal authority in P1's
/// HUMAN-only Converge). Dispatches a `resolve-council-converge` SurfaceCommand: the
/// engine's Conductor — the SOLE bus writer — records the verdict onto the append-only
/// transcript (never a direct store write from the surface, safety #1) and closes the
/// run. The verdict streams back over `nc:debate`, so this is fire-and-forget like its
/// `start_council`/`kill_council` siblings — the transcript entry is the confirmation.
///
/// `seat_id` names the adopted seat for an `accept` verdict; `note` is the ruling for a
/// `judge` (or an optional reason for `accept`/`reject`) and is user content, never
/// logged. When the sidecar isn't running there is no parked run to resolve, so this is
/// a no-op. Async like its siblings — fully async tokio I/O, never blocks the WKWebView.
#[tauri::command]
pub async fn resolve_council_converge(
    provider: State<'_, Arc<SidecarProvider>>,
    run_id: String,
    decision: crate::contracts::CouncilConvergeDecision,
    seat_id: Option<String>,
    note: Option<String>,
) -> Result<(), String> {
    if !provider.is_running().await {
        return Ok(());
    }
    // Decision KIND is debug-only (the verdict category); the ruling `note` is user
    // content and is never logged.
    tracing::debug!(target: "nightcore", run_id, ?decision, "resolve-council-converge dispatched to engine");
    let command = crate::contracts::SurfaceCommand::ResolveCouncilConverge {
        run_id,
        decision,
        seat_id,
        note,
    };
    provider.dispatch_command(command).await
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::Task;

    fn provider() -> SidecarProvider {
        SidecarProvider::new(
            std::path::PathBuf::from("/tmp/entry.ts"),
            std::path::PathBuf::from("/tmp"),
            "claude".to_string(),
        )
    }

    fn store() -> TaskStore {
        TaskStore::load_from(
            std::env::temp_dir().join(format!("nc-send-input-test-{}", uuid::Uuid::new_v4())),
        )
    }

    #[test]
    fn resolve_live_session_errs_with_no_binding_at_all() {
        let p = provider();
        let s = store();
        let err = resolve_live_session(&p, &s, "unknown-task").unwrap_err();
        assert!(err.contains("no live session"), "got: {err}");
    }

    #[test]
    fn resolve_live_session_errs_when_only_a_stale_persisted_session_id_exists() {
        // The task carries a persisted `session_id` from a prior run, but the
        // provider's live correlation map never bound it (e.g. a sidecar crash
        // reset, or the run simply never reached a live session) — the stale
        // fallback must NOT be treated as deliverable.
        let p = provider();
        let s = store();
        let mut task = Task::new("t".to_string(), "d".to_string());
        task.session_id = Some(999);
        s.upsert(&task).expect("seed task persists");

        let err = resolve_live_session(&p, &s, &task.id).unwrap_err();
        assert!(err.contains("no longer live"), "got: {err}");
    }

    #[test]
    fn resolve_live_session_ok_when_the_provider_has_a_live_binding() {
        let p = provider();
        let s = store();
        p.push_pending_for_test("task-live");
        let bound = p.correlate(7);
        assert_eq!(bound.as_deref(), Some("task-live"));

        assert_eq!(resolve_live_session(&p, &s, "task-live"), Ok(7));
    }

    #[test]
    fn resolve_live_session_prefers_the_live_binding_over_a_different_persisted_id() {
        // A task can have BOTH a live correlation binding and an older persisted
        // `session_id` from a prior run; the live binding must win.
        let p = provider();
        let s = store();
        let mut task = Task::new("t".to_string(), "d".to_string());
        task.id = "task-live".to_string();
        task.session_id = Some(111);
        s.upsert(&task).expect("seed task persists");

        p.push_pending_for_test("task-live");
        p.correlate(7);

        assert_eq!(resolve_live_session(&p, &s, "task-live"), Ok(7));
    }
}
