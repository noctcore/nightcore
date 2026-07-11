//! Auto-loop lifecycle (arm/disarm/resume/resize) + the tick driver.
//!
//! The free functions here are the coordinator's lifecycle surface — the
//! `#[tauri::command]` handlers in `mod.rs` are thin wrappers over them, and the
//! settings store resizes the live pool through [`set_max_concurrency`]. The
//! [`run_loop`]/[`tick`] pair is the scan-and-dispatch driver kicked on launch and
//! on terminal events.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::orchestration::deps::eligible_tasks;
use crate::store::TaskStore;

use super::{launch, usage_throttle_reason, LoopReason, Orchestrator};

/// The interval between coordinator ticks. A periodic scan is the simplest correct
/// scanner for time-relative dependency/breaker windows; terminal events also kick
/// an immediate re-tick so latency stays low without a tight spin.
const TICK_INTERVAL: Duration = Duration::from_millis(750);

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
    tauri::async_runtime::spawn(async move {
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
    orch.usage_pause.reset(); // a manual stop ends any usage-pause episode
    orch.kick(); // wake the loop so it observes the stop promptly
    orch.emit_state(app, "drained", Some(LoopReason::Stopped));
    tracing::info!(target: "nightcore", "auto-loop stopped; interrupting in-flight runs");

    // Interrupt in-flight sessions off-thread (the command handler is sync).
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        app.state::<Orchestrator>().interrupt_all().await;
    });
}

/// Clear a circuit-breaker pause so the loop can retry. Re-arms if it was running.
pub fn resume(app: &AppHandle) -> Result<(), String> {
    let orch = app.state::<Orchestrator>();
    orch.breaker.reset();
    // Clearing the loop ends any usage-pause episode too (so a later re-heat notifies
    // afresh). Resuming re-arms the loop (a pause leaves `running` true but gated; an
    // explicit stop set it false). Either way, kick a fresh scan.
    orch.usage_pause.reset();
    tracing::info!(target: "nightcore", "circuit-breaker reset; resuming auto-loop");
    if !orch.auto.is_running() {
        return start(app);
    }
    orch.emit_state(app, "running", Some(LoopReason::Resumed));
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

    // Usage-aware throttle (spec 2026-07-11): a sibling of the breaker gate but
    // NON-LATCHING — a live per-tick read of the usage meter. While the run
    // provider's rate-limit window is hot, stop picking up NEW runs (in-flight runs
    // finish untouched); when the next poll shows it cool, the very next tick
    // proceeds. Precedence is explicit: breaker first (above), then usage. Fail-open
    // — `usage_throttle_reason` returns `None` on any uncertainty, so a flaky meter
    // never halts automation.
    if let Some(pause) = usage_throttle_reason(app) {
        orch.enter_usage_pause(app, &pause);
        return;
    }
    orch.leave_usage_pause(app);

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::breaker::CircuitBreaker;
    use crate::orchestration::slots::SlotManager;
    use crate::task::{Task, TaskStatus};

    fn ready(id: &str, created_at: u64) -> Task {
        let mut t = Task::new(id.to_string(), String::new());
        t.id = id.to_string();
        t.status = TaskStatus::Ready;
        t.created_at = created_at;
        t
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
    fn usage_gate_sits_after_the_breaker_and_never_interrupts() {
        // Spec 2026-07-11 trap (b) + §3.3 precedence: the usage gate is a PRE-LAUNCH
        // sibling of the breaker inside `tick`, placed AFTER the breaker check
        // (breaker precedence) and BEFORE any launch, and it must call NEITHER
        // `stop()` NOR `interrupt_all()` — those interrupt in-flight runs, which
        // decision 1 forbids ("running sessions finish naturally"). A source-level
        // guard, since the behavioral path needs a live `AppHandle`.
        let src = include_str!("auto_loop.rs");
        let tick = src.find("async fn tick(").expect("the tick driver exists");
        let body = &src[tick..];
        let breaker = body
            .find("orch.breaker.is_paused()")
            .expect("the breaker gate is in the tick");
        let usage = body
            .find("usage_throttle_reason(app)")
            .expect("the usage gate is in the tick");
        let launch = body.find("launch(app, &task_id)").expect("the launch site");
        assert!(
            breaker < usage && usage < launch,
            "the usage gate runs after the breaker and before any launch"
        );
        // The usage-pause branch (from the gate to the free-slot scan) must not stop
        // or interrupt anything — it only returns, letting in-flight runs finish.
        let scan = body.find("let free =").expect("the free-slot scan");
        let gate_branch = &body[usage..scan];
        assert!(
            !gate_branch.contains("interrupt_all") && !gate_branch.contains("stop("),
            "the usage gate must never interrupt in-flight runs (pause ≠ stop)"
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

    // --- Spawn-mechanism regression tests (guards the tokio::spawn → tauri::async_runtime::spawn fix) ---

    #[test]
    fn tokio_spawn_panics_off_runtime() {
        // Regression anchor: bare tokio::spawn panics when no Tokio 1.x runtime is
        // entered on the calling thread. This was the pre-fix behavior of start() and
        // stop(), which aborted the process via the WKWebView extern "C" boundary
        // (SIGABRT, nightcore-2026-06-27-161645.ips). Using catch_unwind so the panic
        // is caught rather than crashing the test runner.
        let result = std::panic::catch_unwind(|| {
            // Explicit drop of the JoinHandle: the spawn is EXPECTED to panic before
            // one ever exists — the panic is the assertion, not the spawned work.
            drop(tokio::spawn(async {}));
        });
        assert!(
            result.is_err(),
            "tokio::spawn must panic when no runtime context is entered — \
             this is the pre-fix failure mode that aborted the release app"
        );
    }

    #[test]
    fn tauri_async_runtime_spawn_safe_off_runtime() {
        // The fix: tauri::async_runtime::spawn uses get_or_init(default_runtime),
        // lazily creating a Tokio runtime on first call. Safe from any thread —
        // including the WKWebView main-thread sync command path that has no entered
        // context. start() and stop() use this after the fix.
        let _h = tauri::async_runtime::spawn(async {});
        // Reaching here means no panic — the mechanism is correct.
    }
}
