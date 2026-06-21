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

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
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

/// The shared M2 hub held in managed Tauri state.
pub struct Orchestrator {
    pub slots: SlotManager,
    pub breaker: CircuitBreaker,
    pub provider: SidecarProvider,
    pub auto: AutoLoop,
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
            let _ = self.provider.interrupt(sid).await;
        }
        self.slots.abort_all();
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
        eligible.into_iter().take(free).map(|t| t.id.clone()).collect()
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

    // Allocate the per-task worktree off the active project (if any). With no
    // project, run in the workspace root (M1 behavior) — cwd = None.
    let cwd = match resolve_worktree(app, task_id) {
        Ok(cwd) => cwd,
        Err(e) => {
            fail_task(app, task_id, &format!("worktree setup failed: {e}"));
            orch.slots.release(task_id);
            orch.breaker.record_failure();
            return;
        }
    };

    // Ensure the sidecar is up (the reader is installed by `sidecar::ensure_reader`).
    if let Err(e) = crate::sidecar::ensure_reader(app).await {
        fail_task(app, task_id, &format!("sidecar start failed: {e}"));
        orch.slots.release(task_id);
        orch.breaker.record_failure();
        return;
    }

    // When a worktree was allocated (active project), record its branch on the
    // task so the board's branch chip reflects the real `nc/<taskId>` branch.
    let branch = cwd
        .as_ref()
        .map(|_| worktree::branch_name(task_id));

    // Mark in-progress + persist + emit before dispatch.
    if let Ok(updated) = store.mutate(task_id, |t| {
        t.status = TaskStatus::InProgress;
        t.summary = None;
        t.error = None;
        if branch.is_some() {
            t.branch = branch.clone();
        }
    }) {
        let _ = app.emit(TASK_EVENT, &updated);
    }

    use crate::m2::provider::Provider;
    if let Err(e) = orch
        .provider
        .start_session(task_id, task.prompt(), task.model.clone(), cwd)
        .await
    {
        fail_task(app, task_id, &format!("dispatch failed: {e}"));
        orch.slots.release(task_id);
        orch.breaker.record_failure();
    }
}

/// Resolve the worktree cwd for a run. Returns `Ok(None)` when there is no active
/// project (run in the workspace root, M1 behavior). Refuses to allocate off a
/// dirty base tree.
fn resolve_worktree(app: &AppHandle, task_id: &str) -> Result<Option<PathBuf>, String> {
    let projects = app.state::<ProjectStore>();
    let Some(project) = projects.active() else {
        return Ok(None);
    };
    let project_path = PathBuf::from(&project.path);
    if !worktree::is_worktree_clean(&project_path).unwrap_or(true) {
        return Err(format!(
            "base working tree at {} is dirty; commit or stash before running the loop",
            project_path.display()
        ));
    }
    let dir = worktree::allocate(&project_path, task_id)?;
    Ok(Some(dir))
}

/// Mark a task failed with `message`, persist, and emit `nc:task`.
fn fail_task(app: &AppHandle, task_id: &str, message: &str) {
    let store = app.state::<TaskStore>();
    if let Ok(updated) = store.mutate(task_id, |t| {
        t.status = TaskStatus::Failed;
        t.error = Some(message.to_string());
    }) {
        let _ = app.emit(TASK_EVENT, &updated);
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
    if let Err(e) = worktree::remove(&PathBuf::from(&project.path), task_id) {
        eprintln!("worktree cleanup for {task_id} failed: {e}");
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
        eprintln!("worktree reconcile: pruned {} orphan(s)", pruned.len());
    }
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
        assert_eq!(taken, vec!["a", "b"], "only free-slot many are launched, in order");
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
