//! The shared launch sequence behind the auto-loop and the manual `run_task`
//! command: lease a slot, resolve the run cwd, mark the task `InProgress`, ensure
//! the sidecar reader is up, then dispatch `start-session`. A setup failure after
//! the lease routes through [`fail_run`], feeding the circuit breaker only for the
//! auto-loop path.

use tauri::{AppHandle, Manager};

use crate::orchestration::breaker::CircuitBreaker;
use crate::store::TaskStore;
use crate::worktree;

use super::{fail_task, mark_task_in_progress, resolve_worktree, Orchestrator};

/// The auto-loop entry point: lease + dispatch a task, discarding the result.
/// A lease race (no free slot) is a silent skip — the tick retries next pass — so
/// only `submit_run`'s setup failures (already handled by `fail_run`, which feeds
/// the breaker here) matter. `run_task` shares the same [`submit_run`] sequence but
/// surfaces the error instead and does NOT feed the breaker.
pub(crate) async fn launch(app: &AppHandle, task_id: &str) {
    let _ = submit_run(app, task_id, true).await;
}

/// The shared launch sequence behind the auto-loop [`launch`] and the manual
/// `run_task` command: lease a slot, resolve the run cwd/worktree, mark the task
/// `InProgress` (persist+emit), ensure the sidecar reader is up, then dispatch
/// `start-session`. Mark-in-progress runs BEFORE `ensure_reader` so neither path
/// can strand a task in a started-but-unmarked state.
///
/// The only behavioral knob is `feed_breaker`: a setup failure after the lease is
/// routed through [`fail_run`] (mark Failed + release the slot), feeding the
/// circuit breaker only when `feed_breaker` is set (the auto-loop). A lease race
/// returns `Err` WITHOUT failing the task — nothing was leased, and for the
/// auto-loop it is a benign retry-next-tick skip. The error is both recorded (via
/// `fail_run`) and returned, so `run_task` can map it to its `Result` while the
/// auto-loop discards it.
pub(crate) async fn submit_run(
    app: &AppHandle,
    task_id: &str,
    feed_breaker: bool,
) -> Result<(), String> {
    let orch = app.state::<Orchestrator>();

    // Lease the slot first. A lease race (raced to capacity) is not a task failure:
    // nothing is leased, so there's nothing to release or fail — return the rejection
    // for the caller to surface (`run_task`) or discard (`launch`).
    if !orch.slots.try_lease(task_id) {
        return Err("no free slot (max concurrency reached)".to_string());
    }

    let store = app.state::<TaskStore>();
    let Some(task) = store.get(task_id) else {
        orch.slots.release(task_id);
        return Err(format!("no task with id {task_id}"));
    };

    // Resolve the run cwd off the active project (if any), branching on the task's
    // run mode. With no project, run in the workspace root (M1 behavior) — None.
    let resolved = match resolve_worktree(app, task_id) {
        Ok(cwd) => cwd,
        Err(e) => {
            let msg = format!("worktree setup failed: {e}");
            fail_run(app, task_id, &msg, feed_breaker);
            return Err(msg);
        }
    };

    // Fix-arc dispatch guard: never launch a task INTO a checkout a live PR-fix
    // session (or its auto-commit) is editing — two agents concurrently writing
    // one worktree corrupt each other's work. A fix holds no slot, so the slot
    // lease can't see it; the registry's running entry is the probe. Routed
    // through `fail_run` like every other post-lease setup failure (slot
    // released, task marked failed, breaker fed only on the auto-loop path).
    if let Some(fix) = resolved.as_ref().and_then(|r| {
        app.state::<crate::workflow::pr_fix::PrFixRegistry>()
            .running_for_dir(&r.path)
    }) {
        let msg = format!(
            "a PR fix ({}) for PR #{} is running in this task's worktree — wait for it to \
             finish or cancel it from the PR workspace before running the task",
            fix.id, fix.pr_number
        );
        fail_run(app, task_id, &msg, feed_breaker);
        return Err(msg);
    }

    // A fresh worktree checkout has no `node_modules` of its own, and package-local
    // (non-hoisted) deps never resolve upward past the worktree root — so the agent
    // can't run the project's real checks and the review-time gauntlet red-fails on
    // `Cannot find module` (the empirical dogfood failure: a spurious
    // ChangesRequested that burned a paid fix cycle). Provision the worktree's deps
    // from its committed lockfile BEFORE dispatch, off the async runtime (a cold
    // install can take seconds). Best-effort: a failed install must not fail the
    // run — the agent may not need JS deps at all, and PR-create still hard-gates
    // on its own provisioning.
    if let Some(r) = resolved.as_ref().filter(|r| r.is_worktree) {
        let dir = r.path.clone();
        let tid = task_id.to_string();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = worktree::provision_deps(&dir) {
                tracing::warn!(target: "nightcore", task_id = %tid, error = %e, "worktree dep provisioning failed; continuing without it");
            }
        })
        .await;
    }

    // Only a worktree-mode run carries a `nc/<taskId>` branch chip; a `main`-mode
    // run edits the project's current branch directly, so it has no chip.
    let is_worktree = resolved.as_ref().map(|r| r.is_worktree).unwrap_or(false);
    // The project ROOT the cwd was pinned to, captured from the SAME `active()`
    // read — threaded into `build_guardrails` so the harness policy resolves from
    // this project, not a later `active()` that a mid-launch switch could change.
    let project_root = resolved.as_ref().map(|r| r.project_root.clone());
    let cwd = resolved.map(|r| r.path);
    // The chip is the picker-chosen branch (stored at create) or the default
    // `nc/<taskId>`; `cwd.rs` allocated the worktree on the same branch.
    let branch = is_worktree.then(|| {
        task.branch
            .clone()
            .unwrap_or_else(|| worktree::branch_name(task_id))
    });

    // Mark in-progress + persist + emit BEFORE ensuring the reader, so a sidecar
    // start failure can't strand the task started-but-unmarked.
    if let Err(e) = mark_task_in_progress(app, task_id, branch.clone()) {
        fail_run(app, task_id, &e, feed_breaker);
        return Err(e);
    }

    // Ensure the sidecar is up (the reader is installed by `sidecar::ensure_reader`).
    if let Err(e) = crate::sidecar::ensure_reader(app).await {
        let msg = format!("sidecar start failed: {e}");
        fail_run(app, task_id, &msg, feed_breaker);
        return Err(msg);
    }

    tracing::info!(
        target: "nightcore",
        task_id,
        model = task.model.as_deref().unwrap_or("<default>"),
        kind = task.kind.as_wire(),
        run_mode = ?task.run_mode,
        branch = branch.as_deref().unwrap_or("<project-root>"),
        "launching task"
    );

    use crate::provider::Provider;
    let autonomy = crate::sidecar::resolve_autonomy(app, task.permission_mode.as_deref());
    // SDK-guardrails: forward the per-task autonomy ceilings and, when a prior SDK
    // session id is persisted, resume it so a crashed/restarted build reattaches
    // instead of starting cold (the recovery path). Also injects the project's
    // enabled MCP servers. The reviewer/fix sub-runs are fresh prompts and never
    // resume.
    let guardrails = crate::sidecar::build_guardrails(app, &task, project_root.as_deref());
    // Load the task's image attachments from app-data into wire blocks. An
    // unreadable file is skipped (logged) inside the loader, so a missing
    // attachment never blocks the run; no attachments ⇒ an empty list ⇒ a
    // text-only user message (byte-identical to the pre-feature path).
    let images = crate::store::attachments::load_wire_images(app, task_id, &task.attachments);
    if let Err(e) = orch
        .provider
        .start_session(
            task_id,
            task.prompt(),
            task.provider_id.clone(),
            task.model.clone(),
            task.effort.clone(),
            cwd,
            autonomy,
            task.kind.as_wire(),
            images,
            guardrails,
        )
        .await
    {
        let msg = format!("dispatch failed: {e}");
        fail_run(app, task_id, &msg, feed_breaker);
        return Err(msg);
    }
    Ok(())
}

/// A run's setup failed after the slot was leased (worktree/mark/sidecar/dispatch):
/// mark the task Failed + emit, release its slot, and — only when `feed_breaker` is
/// set (the auto-loop, never a manual `run_task`) — feed the circuit breaker,
/// logging when THIS failure tripped it (observability #1). Shared by both dispatch
/// paths so a setup failure is recorded + observable identically; the breaker guard
/// is the sole difference between an auto-loop launch and a manual run.
fn fail_run(app: &AppHandle, task_id: &str, message: &str, feed_breaker: bool) {
    let orch = app.state::<Orchestrator>();
    fail_task(app, task_id, message);
    orch.slots.release(task_id);
    if feed_breaker_on_failure(&orch.breaker, feed_breaker) {
        tracing::warn!(
            target: "nightcore",
            task_id,
            threshold = orch.breaker.threshold(),
            "circuit breaker tripped on launch failure; pausing auto-loop"
        );
        orch.emit_state(app, "paused", Some("circuit-breaker"));
        let app = app.clone();
        // `tauri::async_runtime::spawn` (not bare `tokio::spawn`) — the latter panics
        // when no Tokio runtime is entered on the calling thread and aborted the release
        // app via SIGABRT across the WKWebView extern-"C" boundary. This mirrors the fix
        // already applied to the sibling start()/stop() (auto_loop.rs) and is guarded by
        // their spawn-mechanism regression tests; a refactor reaching this breaker path
        // from a sync Tauri command/callback thread would otherwise reintroduce the abort.
        tauri::async_runtime::spawn(async move {
            app.state::<Orchestrator>().interrupt_all().await;
        });
    }
}

/// The pure breaker-feed decision behind [`fail_run`]: a post-lease setup failure
/// feeds the circuit breaker **only** on the auto-loop path (`feed_breaker`), never
/// a manual `run_task` (a manual run must not trip the loop's breaker). Returns
/// whether THIS failure tripped the breaker, so the caller pauses + interrupts.
///
/// `&&` short-circuits so `record_failure` — which has the side effect of pushing a
/// timestamp into the sliding window — is NOT called on the manual path; that keeps
/// manual-run failures from silently advancing the auto-loop's failure count.
/// Factored out of the `AppHandle` IO so the auto-loop-vs-manual guard (a documented
/// race area) is unit-testable against a real `CircuitBreaker`.
fn feed_breaker_on_failure(breaker: &CircuitBreaker, feed_breaker: bool) -> bool {
    feed_breaker && breaker.record_failure()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn manual_run_never_feeds_the_breaker() {
        // A manual `run_task` passes feed_breaker=false: a setup failure must NOT
        // record against the loop's breaker, no matter how many times it fails.
        let breaker = CircuitBreaker::new(1, Duration::from_secs(60));
        for _ in 0..5 {
            assert!(
                !feed_breaker_on_failure(&breaker, false),
                "a manual run must never trip the auto-loop breaker"
            );
        }
        assert!(
            !breaker.is_paused(),
            "the breaker stayed untouched by manual-run failures"
        );
    }

    #[test]
    fn auto_loop_failures_feed_and_eventually_trip_the_breaker() {
        // The auto-loop path (feed_breaker=true) records each setup failure; the
        // threshold-th one trips and reports true so fail_run pauses + interrupts.
        let breaker = CircuitBreaker::new(3, Duration::from_secs(60));
        assert!(
            !feed_breaker_on_failure(&breaker, true),
            "1st failure: below threshold"
        );
        assert!(
            !feed_breaker_on_failure(&breaker, true),
            "2nd failure: below threshold"
        );
        assert!(
            feed_breaker_on_failure(&breaker, true),
            "3rd failure trips the breaker → pause the loop"
        );
        assert!(breaker.is_paused());
        // Once tripped, further failures don't re-report the trip.
        assert!(
            !feed_breaker_on_failure(&breaker, true),
            "an already-paused breaker doesn't re-report the trip"
        );
    }

    #[test]
    fn manual_failures_do_not_advance_the_auto_loop_window() {
        // Interleaving proves the guard is the ONLY difference between the two
        // dispatch paths: manual failures must not count toward the threshold, so it
        // still takes a full `threshold` auto-loop failures to trip afterward.
        let breaker = CircuitBreaker::new(2, Duration::from_secs(60));
        for _ in 0..3 {
            assert!(!feed_breaker_on_failure(&breaker, false));
        }
        assert!(
            !feed_breaker_on_failure(&breaker, true),
            "1st auto-loop failure: below threshold (manual ones never counted)"
        );
        assert!(
            feed_breaker_on_failure(&breaker, true),
            "2nd auto-loop failure trips — only auto-loop failures advanced the window"
        );
    }

    #[test]
    fn dispatch_refuses_a_worktree_held_by_a_running_pr_fix() {
        // Concurrency guard: a task must never launch INTO a checkout a live
        // PR-fix session is editing (a fix holds no slot, so the lease can't
        // see it — the registry probe is the only fence). The probe needs a
        // full `AppHandle`, so this is a source-level guard: it must sit
        // between cwd resolution and the dispatch, and its refusal must route
        // through `fail_run` like every other post-lease setup failure (slot
        // released, task marked failed, breaker fed only on the auto-loop path).
        let src = include_str!("submit.rs");
        let resolve = src
            .find("resolve_worktree(app, task_id)")
            .expect("the cwd resolution site exists");
        let probe = src
            .find("running_for_dir")
            .expect("the pr-fix registry probe exists");
        let dispatch = src
            .find(".start_session(")
            .expect("the dispatch site exists");
        assert!(
            resolve < probe && probe < dispatch,
            "the probe runs after cwd resolution and before dispatch"
        );
        let window = &src[probe..dispatch];
        assert!(
            window.contains("fail_run(app, task_id, &msg, feed_breaker)"),
            "the refusal feeds fail_run like every post-lease setup failure"
        );
    }

    #[test]
    fn manual_submit_run_is_never_usage_gated() {
        // Decision 1 (spec 2026-07-11): the usage-aware throttle must gate ONLY the
        // auto-loop's pickup (`tick`), never the shared `submit_run` chokepoint that
        // manual `run_task` also traverses. If the gate leaked into `submit_run`, a
        // hot usage window would block manual starts too — a forbidden regression.
        // Source-level guard (mirrors the pr-fix probe test): `submit_run` must not
        // reference the usage gate at all. The needles are `concat!`-assembled so this
        // guard never flags itself (the joined literal never appears in this file).
        let src = include_str!("submit.rs");
        let reason_needle = concat!("usage_", "throttle_reason");
        let enter_needle = concat!("enter_", "usage_pause");
        assert!(
            !src.contains(reason_needle),
            "submit_run must not consult the usage gate — manual runs stay allowed"
        );
        assert!(
            !src.contains(enter_needle),
            "submit_run must not enter a usage pause — the gate lives only in tick()"
        );
    }

    #[test]
    fn fail_run_breaker_trip_uses_the_guarded_spawn() {
        // Regression guard for the SIGABRT pattern (nightcore-2026-06-27-161645.ips): the
        // breaker-trip branch of `fail_run` must launch `interrupt_all` via
        // `tauri::async_runtime::spawn`, never bare `tokio::spawn` (which panics when no
        // Tokio runtime is entered on the calling thread and aborted the release app across
        // the WKWebView extern-"C" boundary). The spawn site needs a full `AppHandle`, so
        // this is a source-level guard rather than a behavioral one. The forbidden needle is
        // assembled from parts so the literal never appears in this file except where it is
        // (dis)allowed.
        let src = include_str!("submit.rs");
        let bare_spawn = concat!("tokio", "::spawn(async move {");
        assert!(
            !src.contains(bare_spawn),
            "fail_run must NOT use bare tokio::spawn — it aborts off-runtime (SIGABRT)"
        );
        assert!(
            src.contains("tauri::async_runtime::spawn(async move {"),
            "fail_run must launch interrupt_all via the guarded tauri::async_runtime::spawn"
        );
    }
}
