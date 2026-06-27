//! The shared launch sequence behind the auto-loop and the manual `run_task`
//! command: lease a slot, resolve the run cwd, mark the task `InProgress`, ensure
//! the sidecar reader is up, then dispatch `start-session`. A setup failure after
//! the lease routes through [`fail_run`], feeding the circuit breaker only for the
//! auto-loop path.

use tauri::{AppHandle, Manager};

use crate::orchestration::worktree;
use crate::store::TaskStore;

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

    // Only a worktree-mode run carries a `nc/<taskId>` branch chip; a `main`-mode
    // run edits the project's current branch directly, so it has no chip.
    let is_worktree = resolved.as_ref().map(|r| r.is_worktree).unwrap_or(false);
    let cwd = resolved.map(|r| r.path);
    let branch = is_worktree.then(|| worktree::branch_name(task_id));

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

    use crate::orchestration::provider::Provider;
    let permission_mode =
        crate::sidecar::resolve_permission_mode(app, task.permission_mode.as_deref());
    // SDK-guardrails: forward the per-task autonomy ceilings and, when a prior SDK
    // session id is persisted, resume it so a crashed/restarted build reattaches
    // instead of starting cold (the recovery path). Also injects the project's
    // enabled MCP servers. The reviewer/fix sub-runs are fresh prompts and never
    // resume.
    let guardrails = crate::sidecar::build_guardrails(app, &task);
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
            task.model.clone(),
            task.effort.clone(),
            cwd,
            permission_mode,
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
    if !feed_breaker {
        return;
    }
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
