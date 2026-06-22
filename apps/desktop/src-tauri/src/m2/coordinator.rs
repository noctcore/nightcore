//! Auto-loop coordinator + orchestrator state (M2 §2 of the design doc).
//!
//! The [`Orchestrator`] is the single managed-state hub the M2 commands and the
//! sidecar reader share: it owns the [`SlotManager`], the [`CircuitBreaker`], the
//! [`SidecarProvider`], and the [`AutoLoop`] arming flag + kick signal. The
//! coordinator is the only stateful driver — the slot manager, breaker, dependency
//! resolver, and worktree manager are advisors/resources it consults.
//!
//! **Tick** (kicked + interval): while armed and not paused, pull eligible tasks
//! (launchable status, deps satisfied, free slot, not already leased), lease a
//! slot, allocate a worktree, mark `InProgress`, and dispatch the run via the
//! provider with `cwd = <worktree>`. On a terminal event the reader releases the
//! slot, cleans up the worktree (per `cleanupWorktrees`), feeds the breaker, and
//! kicks a re-tick so the board drains without waiting a full interval.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::m2::breaker::CircuitBreaker;
use crate::m2::deps::eligible_tasks;
use crate::m2::provider::SidecarProvider;
use crate::m2::slots::SlotManager;
use crate::m2::worktree;
use crate::project::ProjectStore;
use crate::settings::SettingsStore;
use crate::store::TaskStore;
use crate::task::{TaskStatus, TASK_EVENT};

/// The Tauri event reflecting auto-loop state. Payload:
/// `{ state, reason?, maxConcurrency, leased }`.
pub const LOOP_EVENT: &str = "nc:loop";

/// The interval between coordinator ticks. A periodic scan is the simplest correct
/// scanner for time-relative dependency/breaker windows; terminal events also kick
/// an immediate re-tick so latency stays low without a tight spin.
const TICK_INTERVAL: Duration = Duration::from_millis(750);

/// The auto-loop arming flag + the tick task handle.
#[derive(Default)]
pub struct AutoLoop {
    running: AtomicBool,
    /// Generation counter: bumping it signals the current tick task to exit, so a
    /// stop/start can't leave two tick loops racing.
    generation: AtomicUsize,
}

impl AutoLoop {
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

/// Parked interactive permission requests, keyed by task id. A `permission-required`
/// event registers its `requestId` here; `respond_permission` resolves and removes
/// it; a task's cancel/abort/circuit-break fail-closed-denies and drains every
/// request still parked for that task so a session can never hang.
#[derive(Default)]
pub struct PendingPermissions {
    by_task: Mutex<HashMap<String, Vec<String>>>,
}

impl PendingPermissions {
    /// Record a parked request for a task.
    pub fn register(&self, task_id: &str, request_id: &str) {
        self.by_task
            .lock()
            .expect("pending permissions poisoned")
            .entry(task_id.to_string())
            .or_default()
            .push(request_id.to_string());
    }

    /// Drop a single resolved request from a task's parked set. Returns true when it
    /// was actually parked (so a stale/duplicate decision is a no-op).
    pub fn resolve(&self, task_id: &str, request_id: &str) -> bool {
        let mut guard = self.by_task.lock().expect("pending permissions poisoned");
        let Some(reqs) = guard.get_mut(task_id) else {
            return false;
        };
        let Some(idx) = reqs.iter().position(|r| r == request_id) else {
            return false;
        };
        reqs.remove(idx);
        if reqs.is_empty() {
            guard.remove(task_id);
        }
        true
    }

    /// Take and remove every request still parked for a task (its terminal/abort
    /// drain). Returns the request ids to fail-closed-deny.
    pub fn drain_task(&self, task_id: &str) -> Vec<String> {
        self.by_task
            .lock()
            .expect("pending permissions poisoned")
            .remove(task_id)
            .unwrap_or_default()
    }
}

/// The shared M2 hub held in managed Tauri state.
pub struct Orchestrator {
    pub slots: SlotManager,
    pub breaker: CircuitBreaker,
    pub provider: SidecarProvider,
    pub auto: AutoLoop,
    /// Parked interactive permission requests awaiting a surface decision (M3).
    pub permissions: PendingPermissions,
    /// Kicked to run a tick immediately (on launch, on terminal events).
    kick: Notify,
}

impl Orchestrator {
    /// Build the hub. The provider is configured to spawn `bun run <entry>` in the
    /// workspace root, matching M1.
    pub fn new(entry: PathBuf, cwd: PathBuf, max_concurrency: usize) -> Self {
        Self {
            slots: SlotManager::new(max_concurrency),
            breaker: CircuitBreaker::default(),
            provider: SidecarProvider::new(entry, cwd),
            auto: AutoLoop::default(),
            permissions: PendingPermissions::default(),
            kick: Notify::new(),
        }
    }

    /// Wake the coordinator to run a tick now.
    pub fn kick(&self) {
        self.kick.notify_one();
    }

    /// Interrupt every in-flight run (the effective cancellation — a run lives in
    /// the sidecar process, so `interrupt` is what actually stops it). The runs
    /// then emit `session-failed (aborted)`, which releases their slots via the
    /// reader. Also aborts any attached driver task as bookkeeping.
    pub async fn interrupt_all(&self) {
        use crate::m2::provider::Provider;
        for sid in self.provider.live_sessions() {
            // Fail-closed: deny any parked permission request for this run before
            // interrupting, so a session waiting on approval doesn't hang.
            if let Some(task_id) = self.provider.task_for(sid) {
                self.deny_parked_permissions(&task_id).await;
            }
            if let Err(e) = self.provider.interrupt(sid).await {
                // Best-effort: the session may already be tearing down. Log so a
                // wedged interrupt is visible rather than silently swallowed (#8).
                tracing::warn!(target: "nightcore", session_id = sid, error = %e, "interrupt of in-flight session failed");
            }
        }
        self.slots.abort_all();
    }

    /// Fail-closed: deny every permission request still parked for `task_id` and
    /// clear them. Called when a task is cancelled, aborted, or circuit-broken so a
    /// session waiting on a surface decision can never hang. Resolving the session
    /// id is best-effort — once the run is torn down the binding may already be
    /// gone, in which case the engine's own teardown (`failAllPending`) denies it.
    pub async fn deny_parked_permissions(&self, task_id: &str) {
        use crate::m2::provider::{PermissionDecision, Provider};
        let request_ids = self.permissions.drain_task(task_id);
        if request_ids.is_empty() {
            return;
        }
        let Some(session_id) = self.provider.session_for(task_id) else {
            return;
        };
        for request_id in request_ids {
            let _ = self
                .provider
                .decide_permission(
                    session_id,
                    &request_id,
                    PermissionDecision::Deny {
                        message: "Nightcore: task cancelled before approval.".to_string(),
                    },
                )
                .await;
        }
    }

    /// Emit `nc:loop` with the current loop snapshot.
    pub fn emit_state(&self, app: &AppHandle, state: &str, reason: Option<&str>) {
        let _ = app.emit(
            LOOP_EVENT,
            serde_json::json!({
                "state": state,
                "reason": reason,
                "maxConcurrency": self.slots.max(),
                "leased": self.slots.leased_count(),
                "failureThreshold": self.breaker.threshold(),
            }),
        );
    }
}

/// Arm the auto-loop and spawn the tick task (idempotent: a second arm is a no-op
/// that just kicks a tick). Clears any circuit-breaker pause is the caller's job
/// (`resume_auto_loop`) — `start` does not silently un-pause.
pub fn start(app: &AppHandle) -> Result<(), String> {
    let orch = app.state::<Orchestrator>();
    if orch.auto.running.swap(true, Ordering::SeqCst) {
        orch.kick(); // already running; just nudge a scan
        return Ok(());
    }
    let generation = orch.auto.generation.fetch_add(1, Ordering::SeqCst) + 1;
    orch.emit_state(app, "running", None);
    tracing::info!(target: "nightcore", max_concurrency = orch.slots.max(), "auto-loop armed");

    let app = app.clone();
    tokio::spawn(async move {
        run_loop(app, generation).await;
    });
    Ok(())
}

/// Disarm the auto-loop and interrupt every in-flight run. The interrupted runs
/// produce `session-failed (aborted)` events that release their slots via the
/// reader.
pub fn stop(app: &AppHandle) {
    let orch = app.state::<Orchestrator>();
    orch.auto.running.store(false, Ordering::SeqCst);
    orch.auto.generation.fetch_add(1, Ordering::SeqCst); // signal the tick task to exit
    orch.kick(); // wake the loop so it observes the stop promptly
    orch.emit_state(app, "drained", Some("stopped"));
    tracing::info!(target: "nightcore", "auto-loop stopped; interrupting in-flight runs");

    // Interrupt in-flight sessions off-thread (the command handler is sync).
    let app = app.clone();
    tokio::spawn(async move {
        app.state::<Orchestrator>().interrupt_all().await;
    });
}

/// Clear a circuit-breaker pause so the loop can retry. Re-arms if it was running.
pub fn resume(app: &AppHandle) -> Result<(), String> {
    let orch = app.state::<Orchestrator>();
    orch.breaker.reset();
    // Resuming re-arms the loop (a pause leaves `running` true but gated; an
    // explicit stop set it false). Either way, kick a fresh scan.
    tracing::info!(target: "nightcore", "circuit-breaker reset; resuming auto-loop");
    if !orch.auto.is_running() {
        return start(app);
    }
    orch.emit_state(app, "running", Some("resumed"));
    orch.kick();
    Ok(())
}

/// Resize the slot pool and reflect it in `nc:loop`.
pub fn set_max_concurrency(app: &AppHandle, n: usize) {
    let orch = app.state::<Orchestrator>();
    orch.slots.set_max(n);
    let state = if orch.breaker.is_paused() {
        "paused"
    } else if orch.auto.is_running() {
        "running"
    } else {
        "drained"
    };
    orch.emit_state(app, state, None);
    orch.kick();
}

/// The tick task: ticks on an interval and whenever kicked, until a newer
/// generation supersedes it or the loop is stopped.
async fn run_loop(app: AppHandle, generation: usize) {
    loop {
        let orch = app.state::<Orchestrator>();
        // A newer start()/stop() bumped the generation: this task is stale, exit.
        if orch.auto.generation.load(Ordering::SeqCst) != generation || !orch.auto.is_running() {
            return;
        }
        tick(&app).await;

        // Wait for the next interval or a kick, whichever comes first.
        let kicked = orch.kick.notified();
        tokio::select! {
            _ = kicked => {}
            _ = tokio::time::sleep(TICK_INTERVAL) => {}
        }
    }
}

/// One scan-and-dispatch pass. Gated on `running` and `!paused`; leases and
/// launches up to `free_slots` eligible tasks.
async fn tick(app: &AppHandle) {
    let orch = app.state::<Orchestrator>();
    if !orch.auto.is_running() || orch.breaker.is_paused() {
        return;
    }

    let free = orch.slots.free_slots();
    if free == 0 {
        return;
    }

    let store = app.state::<TaskStore>();
    let tasks = store.list();
    let candidates: Vec<String> = {
        let eligible = eligible_tasks(&tasks, |id| orch.slots.is_leased(id));
        eligible
            .into_iter()
            .take(free)
            .map(|t| t.id.clone())
            .collect()
    };

    if candidates.is_empty() {
        // Nothing to launch. If nothing is in flight either, the board is drained.
        if orch.slots.leased_count() == 0 {
            orch.emit_state(app, "drained", None);
        }
        return;
    }

    for task_id in candidates {
        launch(app, &task_id).await;
    }
    orch.emit_state(app, "running", None);
}

/// Lease a slot, allocate a worktree, mark the task `InProgress`, and dispatch the
/// run. On any setup failure the slot is released and the task is failed so the
/// loop doesn't wedge on it.
async fn launch(app: &AppHandle, task_id: &str) {
    let orch = app.state::<Orchestrator>();

    // Lease the slot first; if it can't be leased (raced to capacity) skip.
    if !orch.slots.try_lease(task_id) {
        return;
    }

    let store = app.state::<TaskStore>();
    let Some(task) = store.get(task_id) else {
        orch.slots.release(task_id);
        return;
    };

    // Resolve the run cwd off the active project (if any), branching on the task's
    // run mode. With no project, run in the workspace root (M1 behavior) — None.
    let resolved = match resolve_worktree(app, task_id) {
        Ok(cwd) => cwd,
        Err(e) => {
            fail_launch(app, task_id, &format!("worktree setup failed: {e}"));
            return;
        }
    };

    // Ensure the sidecar is up (the reader is installed by `sidecar::ensure_reader`).
    if let Err(e) = crate::sidecar::ensure_reader(app).await {
        fail_launch(app, task_id, &format!("sidecar start failed: {e}"));
        return;
    }

    // Only a worktree-mode run carries a `nc/<taskId>` branch chip; a `main`-mode
    // run edits the project's current branch directly, so it has no chip.
    let is_worktree = resolved.as_ref().map(|r| r.is_worktree).unwrap_or(false);
    let cwd = resolved.map(|r| r.path);
    let branch = is_worktree.then(|| worktree::branch_name(task_id));

    // Mark in-progress + persist + emit before dispatch (shared with `run_task`).
    let _ = mark_task_in_progress(app, task_id, branch.clone());

    tracing::info!(
        target: "nightcore",
        task_id,
        model = task.model.as_deref().unwrap_or("<default>"),
        kind = task.kind.as_wire(),
        run_mode = ?task.run_mode,
        branch = branch.as_deref().unwrap_or("<project-root>"),
        "launching task"
    );

    use crate::m2::provider::Provider;
    let permission_mode =
        crate::sidecar::resolve_permission_mode(app, task.permission_mode.as_deref());
    // SDK-guardrails: forward the per-task autonomy ceilings and, when a prior SDK
    // session id is persisted, resume it so a crashed/restarted build reattaches
    // instead of starting cold (the recovery path). The reviewer/fix sub-runs are
    // fresh prompts and never resume.
    let guardrails = crate::sidecar::build_guardrails(&task);
    if let Err(e) = orch
        .provider
        .start_session(
            task_id,
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
        fail_launch(app, task_id, &format!("dispatch failed: {e}"));
    }
}

/// An auto-loop launch setup failed (worktree/sidecar/dispatch): mark the task
/// Failed + emit, release its slot, and feed the circuit breaker — logging when
/// THIS failure tripped it (observability #1). Shared by the three `launch` setup
/// paths so a launch failure is recorded + observable identically. (The manual
/// `run_task` path uses `fail_task` directly: it must NOT feed the loop breaker.)
fn fail_launch(app: &AppHandle, task_id: &str, message: &str) {
    let orch = app.state::<Orchestrator>();
    fail_task(app, task_id, message);
    orch.slots.release(task_id);
    if orch.breaker.record_failure() {
        tracing::warn!(
            target: "nightcore",
            task_id,
            threshold = orch.breaker.threshold(),
            "circuit breaker tripped on launch failure; pausing auto-loop"
        );
        orch.emit_state(app, "paused", Some("circuit-breaker"));
        let app = app.clone();
        tokio::spawn(async move {
            app.state::<Orchestrator>().interrupt_all().await;
        });
    }
}

/// Resolve the run cwd for a task, branching on its `run_mode` (M4.6 §B). Returns
/// `Ok(None)` when there is no active project (run in the workspace root, M1
/// behavior). For `main` mode the cwd is the project ROOT (edits land on the
/// current branch directly); the dirty-base refusal is intentionally relaxed —
/// the user chose to work in the project tree. For `worktree` mode a `nc/<taskId>`
/// worktree is allocated off a CLEAN base (you can't branch cleanly off a dirty
/// index, so that guard stays here). The returned dir is paired with whether it is
/// a worktree so the caller only records a branch chip in worktree mode.
pub(crate) fn resolve_worktree(
    app: &AppHandle,
    task_id: &str,
) -> Result<Option<ResolvedCwd>, String> {
    let projects = app.state::<ProjectStore>();
    let Some(project) = projects.active() else {
        return Ok(None);
    };
    let project_path = PathBuf::from(&project.path);

    let run_mode = app
        .state::<TaskStore>()
        .get(task_id)
        .map(|t| t.run_mode)
        .unwrap_or_default();

    if !run_mode.is_worktree() {
        // `main` mode: run in the project root on the current branch. No worktree,
        // no branch chip, no dirty-base refusal (working in the tree is the point).
        tracing::info!(target: "nightcore", task_id, root = %project_path.display(), "running in project root (main mode)");
        return Ok(Some(ResolvedCwd::root(project_path)));
    }

    if !worktree::is_worktree_clean(&project_path).unwrap_or(true) {
        return Err(format!(
            "base working tree at {} is dirty; commit or stash before running the loop in worktree mode",
            project_path.display()
        ));
    }
    let dir = worktree::allocate(&project_path, task_id)?;
    tracing::info!(target: "nightcore", task_id, worktree = %dir.display(), "allocated worktree");
    Ok(Some(ResolvedCwd::worktree(dir)))
}

/// A resolved run cwd plus whether it is an isolated worktree. `is_worktree`
/// distinguishes a `main`-mode project-root run (no branch chip, no auto-merge)
/// from a `worktree`-mode run (`nc/<taskId>` branch).
pub struct ResolvedCwd {
    pub path: PathBuf,
    pub is_worktree: bool,
}

impl ResolvedCwd {
    fn root(path: PathBuf) -> Self {
        Self {
            path,
            is_worktree: false,
        }
    }
    fn worktree(path: PathBuf) -> Self {
        Self {
            path,
            is_worktree: true,
        }
    }
}

/// Mark a task `InProgress` for a fresh run: clear the prior summary/error and the
/// verification verdict (M4 §B), and record the run's `branch` chip (worktree mode
/// only; main mode clears any stale branch). Persists and emits `nc:task` on
/// success. Shared by the auto-loop `launch` and the manual `run_task` so the two
/// dispatch paths mark a run identically.
pub(crate) fn mark_task_in_progress(
    app: &AppHandle,
    task_id: &str,
    branch: Option<String>,
) -> Result<crate::task::Task, String> {
    let updated = app.state::<TaskStore>().mutate(task_id, |t| {
        t.status = TaskStatus::InProgress;
        t.summary = None;
        t.error = None;
        t.verified = false;
        t.review = None;
        t.fix_attempts = 0;
        t.branch = branch.clone();
    })?;
    let _ = app.emit(TASK_EVENT, &updated);
    Ok(updated)
}

/// Mark a task failed with `message`, persist, and emit `nc:task`. Shared by the
/// auto-loop `launch` and the manual `run_task` setup paths so a launch failure is
/// recorded identically; the breaker is fed by the auto-loop caller only (a manual
/// run must not trip the loop's circuit breaker).
pub(crate) fn fail_task(app: &AppHandle, task_id: &str, message: &str) {
    let store = app.state::<TaskStore>();
    tracing::error!(target: "nightcore", task_id, error = message, "task launch failed");
    if let Ok(updated) = store.mutate(task_id, |t| {
        t.status = TaskStatus::Failed;
        t.error = Some(message.to_string());
    }) {
        let _ = app.emit(TASK_EVENT, &updated);
        // A launch failure is a genuine terminal Failed that never reaches
        // `finish_run`; notify the same way (M3 §C, gated on `notify_on_complete`).
        crate::sidecar::notify_task_complete(app, task_id, false);
    }
}

/// Clean up a finished task's worktree per the `cleanupWorktrees` setting. `Done`
/// with cleanup-on removes the worktree (the `nc/<id>` branch is kept for review);
/// `Failed`/cancelled always retain it for debuggability. Called by the reader on
/// terminal events.
pub fn cleanup_worktree(app: &AppHandle, task_id: &str, succeeded: bool) {
    if !succeeded {
        return; // retain failed/cancelled worktrees for inspection
    }
    let settings = app.state::<SettingsStore>();
    if !settings.get().cleanup_worktrees {
        return;
    }
    let projects = app.state::<ProjectStore>();
    let Some(project) = projects.active() else {
        return;
    };
    match worktree::remove(&PathBuf::from(&project.path), task_id) {
        Ok(()) => tracing::debug!(target: "nightcore", task_id, "worktree cleaned up"),
        Err(e) => {
            tracing::warn!(target: "nightcore", task_id, error = %e, "worktree cleanup failed")
        }
    }
}

/// Startup reconciliation: prune orphaned worktrees (no live task) for the active
/// project. Safe no-op when there's no active project.
pub fn reconcile_worktrees(app: &AppHandle) {
    let projects = app.state::<ProjectStore>();
    let Some(project) = projects.active() else {
        return;
    };
    let store = app.state::<TaskStore>();
    let live: Vec<String> = store.list().into_iter().map(|t| t.id).collect();
    let pruned = worktree::reconcile(&PathBuf::from(&project.path), &live);
    if !pruned.is_empty() {
        tracing::info!(target: "nightcore", pruned = pruned.len(), "worktree reconcile pruned orphans");
    }
}

/// How a crash-stranded task was recovered at boot, returned by the pure inner so
/// callers (and tests) can assert and log per-task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// An `InProgress`/`Verifying` task reset to `Ready` for a fresh run.
    Requeued,
}

/// Boot reconciliation (M4.5 §A): recover tasks stranded mid-run by a crash.
///
/// In-flight orchestrator state (slot leases, the session↔task map, the breaker)
/// is all in-memory and starts empty after a restart, and the auto-loop only
/// re-picks `Backlog`/`Ready` — so a task persisted as `InProgress`/`Verifying`
/// when the process died is stranded forever (its sidecar, which would emit the
/// terminal event, is dead too). Reset such tasks to `Ready` so the loop re-picks
/// them, clearing the stale `session_id` (it points at a dead session that
/// `cancel_task`/`respond_permission` would trust) and the verification verdict a
/// fresh run would clear, and append a note to `task.error`.
///
/// **`Verifying` path — reset, not re-dispatch.** The contract prefers
/// re-dispatching the reviewer over the retained worktree, but boot reconciliation
/// runs synchronously in the Tauri setup hook and the sidecar is spawned lazily
/// (first `run_task`/tick), so there is no live session to dispatch into here.
/// Per the contract's fallback, `Verifying` is reset to `Ready` exactly like
/// `InProgress`; the next run re-builds and re-reviews from scratch (RESUME is P1).
pub fn reconcile_tasks(app: &AppHandle) {
    let store = app.state::<TaskStore>();
    let mut requeued = 0usize;
    for task in store.list() {
        let Some((status, _)) = reconcile_task_inner(&task.status) else {
            continue;
        };
        match store.mutate(&task.id, apply_recovery) {
            Ok(updated) => {
                requeued += 1;
                tracing::info!(
                    target: "nightcore",
                    task_id = %updated.id,
                    from = ?status,
                    "requeued crash-stranded task to Ready"
                );
                let _ = app.emit(TASK_EVENT, &updated);
            }
            Err(e) => {
                tracing::warn!(target: "nightcore", task_id = %task.id, error = %e, "failed to requeue stranded task");
            }
        }
    }
    if requeued > 0 {
        tracing::info!(target: "nightcore", requeued, "boot reconciliation requeued stranded tasks");
    } else {
        tracing::debug!(target: "nightcore", "boot reconciliation found no stranded tasks");
    }
}

/// The pure decision behind [`reconcile_tasks`]: given a task's persisted status,
/// decide whether (and how) it must be recovered. `InProgress`/`Verifying` →
/// `Some((status, Recovery::Requeued))`; every other status (terminal, launchable,
/// or awaiting approval) → `None` (left untouched). No `AppHandle`, so it is
/// unit-testable like `move_task_inner`.
fn reconcile_task_inner(status: &TaskStatus) -> Option<(TaskStatus, Recovery)> {
    match status {
        TaskStatus::InProgress | TaskStatus::Verifying => Some((*status, Recovery::Requeued)),
        _ => None,
    }
}

/// Apply the requeue recovery to a task in place: reset to `Ready`, clear the stale
/// session id + the verification fields a fresh run would clear, and append the
/// interrupted note to `error`. Pure; shared by `reconcile_tasks` and its tests.
fn apply_recovery(t: &mut crate::task::Task) {
    t.status = TaskStatus::Ready;
    t.session_id = None;
    t.verified = false;
    t.review = None;
    t.fix_attempts = 0;
    t.error = Some(match t.error.take() {
        Some(prev) if !prev.is_empty() => format!("{prev}\nInterrupted by restart — requeued."),
        _ => "Interrupted by restart — requeued.".to_string(),
    });
}

// --- Commands ---------------------------------------------------------------

/// Arm the coordinator: start pulling eligible tasks off the board and running
/// them up to the concurrency cap, in isolated worktrees, respecting deps.
#[tauri::command]
pub fn start_auto_loop(app: AppHandle) -> Result<(), String> {
    start(&app)
}

/// Disarm the coordinator and abort every in-flight run.
#[tauri::command]
pub fn stop_auto_loop(app: AppHandle) -> Result<(), String> {
    stop(&app);
    Ok(())
}

/// Clear a circuit-breaker pause and resume the loop.
#[tauri::command]
pub fn resume_auto_loop(app: AppHandle) -> Result<(), String> {
    resume(&app)
}

/// Resize the parallel-run pool (1..=N). Persisted concurrency lives in settings;
/// this applies it to the live pool.
#[tauri::command]
pub fn set_max_concurrency_cmd(app: AppHandle, n: usize) -> Result<(), String> {
    set_max_concurrency(&app, n);
    Ok(())
}

/// List the live Nightcore worktrees for the active project (M4.6 §C): each
/// `nc/<taskId>` worktree on disk with its `{ branch, path, taskIds, dirty,
/// aheadOfBase }`, driving the web switcher's monitor indicators. Read-only and
/// cheap; tolerant of a missing/locked worktree (it degrades to safe defaults).
/// Returns an empty list when there is no active project.
#[tauri::command]
pub fn list_worktrees(app: AppHandle) -> Result<Vec<worktree::WorktreeStatus>, String> {
    let Some(project) = app.state::<ProjectStore>().active() else {
        return Ok(Vec::new());
    };
    Ok(worktree::list_worktree_statuses(&PathBuf::from(
        &project.path,
    )))
}

/// Silence the unused-import lint for `Arc`/`Notify` when only `Notify` is used
/// directly; `Arc` is kept available for a future shared-handle path.
#[allow(dead_code)]
type SharedNotify = Arc<Notify>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::m2::deps::eligible_tasks;
    use crate::task::Task;

    fn ready(id: &str, created_at: u64) -> Task {
        let mut t = Task::new(id.to_string(), String::new());
        t.id = id.to_string();
        t.status = TaskStatus::Ready;
        t.created_at = created_at;
        t
    }

    #[test]
    fn pending_permissions_register_resolve_and_drain() {
        let pending = PendingPermissions::default();
        pending.register("task-1", "req-a");
        pending.register("task-1", "req-b");
        pending.register("task-2", "req-c");

        // Resolving a parked request returns true and removes only it.
        assert!(pending.resolve("task-1", "req-a"));
        // A stale/duplicate resolve is a no-op.
        assert!(!pending.resolve("task-1", "req-a"));
        assert!(!pending.resolve("task-9", "ghost"));

        // Draining a task takes everything still parked for it (fail-closed deny set).
        let drained = pending.drain_task("task-1");
        assert_eq!(drained, vec!["req-b".to_string()]);
        // Draining again is empty; the entry is gone.
        assert!(pending.drain_task("task-1").is_empty());
        // Other tasks are untouched.
        assert_eq!(pending.drain_task("task-2"), vec!["req-c".to_string()]);
    }

    #[test]
    fn auto_loop_starts_disarmed() {
        let auto = AutoLoop::default();
        assert!(!auto.is_running(), "loop is off until started");
    }

    #[test]
    fn eligibility_respects_free_slots_via_take() {
        // The tick takes only `free` candidates; this mirrors that slice without a
        // live AppHandle (which a unit test can't build).
        let tasks = vec![ready("a", 1), ready("b", 2), ready("c", 3)];
        let eligible = eligible_tasks(&tasks, |_| false);
        assert_eq!(eligible.len(), 3);

        let free = 2usize;
        let taken: Vec<&str> = eligible.iter().take(free).map(|t| t.id.as_str()).collect();
        assert_eq!(
            taken,
            vec!["a", "b"],
            "only free-slot many are launched, in order"
        );
    }

    #[test]
    fn paused_breaker_yields_no_launches() {
        // The tick gate is `running && !paused`; exercise the breaker side here.
        let breaker = CircuitBreaker::new(1, Duration::from_secs(60));
        assert!(!breaker.is_paused());
        breaker.record_failure();
        assert!(breaker.is_paused(), "a trip pauses the loop gate");
    }

    #[test]
    fn reconcile_inner_requeues_in_flight_and_leaves_others_untouched() {
        // In-flight statuses are recovered…
        for status in [TaskStatus::InProgress, TaskStatus::Verifying] {
            assert_eq!(
                reconcile_task_inner(&status),
                Some((status, Recovery::Requeued)),
                "{status:?} must be requeued"
            );
        }
        // …everything terminal / launchable / awaiting-approval is left alone.
        for status in [
            TaskStatus::Backlog,
            TaskStatus::Ready,
            TaskStatus::WaitingApproval,
            TaskStatus::Done,
            TaskStatus::Failed,
        ] {
            assert!(
                reconcile_task_inner(&status).is_none(),
                "{status:?} must be left untouched"
            );
        }
    }

    #[test]
    fn apply_recovery_resets_status_session_and_verify_fields() {
        let mut t = Task::new("t".into(), String::new());
        t.status = TaskStatus::InProgress;
        t.session_id = Some(42);
        t.verified = true;
        t.review = Some("prior review".into());
        t.fix_attempts = 2;

        apply_recovery(&mut t);

        assert_eq!(
            t.status,
            TaskStatus::Ready,
            "reset to Ready so the loop re-picks it"
        );
        assert!(t.session_id.is_none(), "stale dead-session id is cleared");
        assert!(
            !t.verified,
            "verification verdict is cleared for a fresh run"
        );
        assert!(t.review.is_none());
        assert_eq!(t.fix_attempts, 0);
        assert_eq!(
            t.error.as_deref(),
            Some("Interrupted by restart — requeued."),
            "the interrupted note is appended"
        );
    }

    #[test]
    fn apply_recovery_appends_note_to_existing_error() {
        let mut t = Task::new("t".into(), String::new());
        t.status = TaskStatus::Verifying;
        t.error = Some("earlier failure detail".into());

        apply_recovery(&mut t);

        assert_eq!(
            t.error.as_deref(),
            Some("earlier failure detail\nInterrupted by restart — requeued."),
            "the note is appended, not clobbering prior context"
        );
    }

    #[test]
    fn reconcile_over_a_store_requeues_only_stranded_tasks() {
        // Seed a store the way `reconcile_tasks` reads it (the pure decision +
        // apply_recovery + store.mutate, without a live AppHandle).
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let store = TaskStore::load_from(tmp.path().join("tasks"));

        let seed = |status: TaskStatus| -> String {
            let mut t = Task::new("seed".into(), String::new());
            t.status = status;
            let id = t.id.clone();
            store.upsert(&t).expect("seed");
            id
        };
        let in_progress = seed(TaskStatus::InProgress);
        let verifying = seed(TaskStatus::Verifying);
        let done = seed(TaskStatus::Done);
        let backlog = seed(TaskStatus::Backlog);

        // Mirror `reconcile_tasks`'s body without an AppHandle.
        for task in store.list() {
            if reconcile_task_inner(&task.status).is_some() {
                store.mutate(&task.id, apply_recovery).expect("requeue");
            }
        }

        assert_eq!(store.get(&in_progress).unwrap().status, TaskStatus::Ready);
        assert_eq!(store.get(&verifying).unwrap().status, TaskStatus::Ready);
        assert_eq!(
            store.get(&done).unwrap().status,
            TaskStatus::Done,
            "terminal untouched"
        );
        assert_eq!(
            store.get(&backlog).unwrap().status,
            TaskStatus::Backlog,
            "backlog untouched"
        );
    }

    #[test]
    fn slots_cap_concurrent_launches() {
        // With max=2 and three eligible tasks, only two can hold slots at once.
        let slots = SlotManager::new(2);
        let tasks = vec![ready("a", 1), ready("b", 2), ready("c", 3)];
        let mut launched = Vec::new();
        for t in eligible_tasks(&tasks, |id| slots.is_leased(id)) {
            if slots.try_lease(&t.id) {
                launched.push(t.id.clone());
            }
        }
        assert_eq!(launched, vec!["a", "b"], "third is refused at capacity");
        assert_eq!(slots.free_slots(), 0);
    }
}
