//! The persistent provider sidecar reader and the run/cancel commands.
//!
//! Protocol (line-delimited JSON over the child's stdio):
//!   - we WRITE one `SurfaceCommand` JSON object per line to the sidecar's stdin
//!   - we READ one `NightcoreEvent` JSON object per line from its stdout
//!   - the sidecar's stderr is human logs; we CAPTURE it (provider.rs pipes it)
//!     and re-emit each line through the Rust `tracing` sink under target `sidecar`
//!
//! M2 generalizes M1's single-task serial path to N concurrent sessions through
//! ONE persistent sidecar (the engine's `SessionManager` already multiplexes
//! sessions). The change from M1: the reader correlates each event to a task via
//! the provider's `sessionId → taskId` map (M1 tagged everything with the single
//! `active_task`). Concurrency is bounded by the [`SlotManager`]; a run holds a
//! slot from lease until its terminal event releases it.
//!
//! `run_task` stays as the manual single-run path (useful even with the loop):
//! it leases a slot, allocates a worktree, and dispatches — exactly what the
//! coordinator's `launch` does, just triggered by a click instead of a tick.

use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::kind;
use crate::m2::coordinator::{self, Orchestrator};
use crate::m2::provider::{parse_line, PermissionDecision, Provider};
use crate::m2::worktree;
use crate::project::ProjectStore;
use crate::store::TaskStore;
use crate::task::{Task, TaskKind, TaskStatus, TASK_EVENT};

/// The Tauri event carrying one streamed sidecar event for a task.
/// Payload: `{ taskId: string, event: NightcoreEvent }`.
pub const SESSION_EVENT: &str = "nc:session";

/// The Tauri event carrying an interactive permission prompt for a task. Payload:
/// `{ taskId, requestId, toolName, input, suggestions? }`. The webview renders the
/// prompt and answers via the `respond_permission` command. Permission inputs may
/// contain paths/commands — they are surfaced to the UI but NEVER logged.
pub const PERMISSION_EVENT: &str = "nc:permission";

/// The tool name the SDK uses when the agent finishes a plan in `plan` mode. It
/// surfaces as a `permission-required`; the core gates it as plan approval rather
/// than a generic tool prompt.
const EXIT_PLAN_MODE: &str = "ExitPlanMode";

/// The bounded auto-fix budget for the verification gate (M4 §B). On a
/// `CHANGES_REQUESTED` verdict the core dispatches up to this many fix-build
/// sessions before parking the task for human approval.
pub const MAX_FIX_ATTEMPTS: u32 = 2;

/// Ensure the persistent sidecar is running and its stdout reader is installed.
/// Idempotent: spawns lazily on first use, then a no-op. Shared by `run_task` and
/// the coordinator's `launch`.
pub async fn ensure_reader(app: &AppHandle) -> Result<(), String> {
    let orch = app.state::<Orchestrator>();
    tracing::info!(target: "nightcore", "ensuring sidecar is up");
    let Some(streams) = orch.provider.spawn().await? else {
        return Ok(()); // already running
    };
    tracing::info!(target: "sidecar", "sidecar spawned (bun)");
    let crate::m2::provider::SidecarStreams { stdout, stderr } = streams;

    // The reader outlives every individual run: it streams the single persistent
    // sidecar's stdout for the whole app lifetime, correlating each event to its
    // task and applying terminal transitions + slot release + worktree cleanup.
    let reader_app = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(raw)) => match parse_line(&raw) {
                    Some(Ok(event)) => handle_event(&reader_app, event).await,
                    // A protocol parse error: the bad line is debug-only (it may
                    // echo content), the failure itself is a warn.
                    Some(Err(e)) => tracing::warn!(target: "sidecar", error = %e, "sidecar protocol parse error"),
                    None => {}
                },
                Ok(None) => {
                    tracing::warn!(target: "sidecar", "sidecar stdout closed (process exited)");
                    break;
                }
                Err(e) => {
                    tracing::error!(target: "sidecar", error = %e, "error reading sidecar stdout");
                    break;
                }
            }
        }
    });

    // Drain the sidecar's stderr (now piped, M4.5 §B4): re-emit each leveled line
    // through the Rust `tracing` sink under target `sidecar` so it lands in the same
    // colored console + rolling file. stdout stays the pure NDJSON protocol.
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(raw)) = lines.next_line().await {
            if raw.trim().is_empty() {
                continue;
            }
            emit_sidecar_line(&raw);
        }
    });

    Ok(())
}

/// Re-emit one captured sidecar stderr line through the Rust `tracing` sink under
/// target `sidecar`, mapping the sidecar's own `LEVEL` token to a tracing level when
/// it's cheaply parseable (the logger emits `<ISO> <LEVEL> [scope] …`), else `info`.
/// The whole original line is the message — the sidecar already shaped it.
fn emit_sidecar_line(line: &str) {
    match sidecar_level(line) {
        SidecarLevel::Error => tracing::error!(target: "sidecar", "{line}"),
        SidecarLevel::Warn => tracing::warn!(target: "sidecar", "{line}"),
        SidecarLevel::Info => tracing::info!(target: "sidecar", "{line}"),
        SidecarLevel::Debug => tracing::debug!(target: "sidecar", "{line}"),
    }
}

/// The level a captured sidecar line maps to. Defaults to `Info` when no known
/// token is present (an SDK/runtime line without our logger's shape).
enum SidecarLevel {
    Error,
    Warn,
    Info,
    Debug,
}

/// Parse the sidecar logger's `LEVEL` token (the second whitespace field, after the
/// ISO timestamp) into a level. Unknown/absent ⇒ `Info`.
fn sidecar_level(line: &str) -> SidecarLevel {
    let token = line.split_whitespace().nth(1).unwrap_or("");
    match token {
        "ERROR" => SidecarLevel::Error,
        "WARN" => SidecarLevel::Warn,
        "DEBUG" => SidecarLevel::Debug,
        _ => SidecarLevel::Info,
    }
}

/// Process one parsed sidecar event: correlate it to its task, forward it as
/// `nc:session`, auto-deny permission requests, and apply terminal transitions
/// (releasing the slot, cleaning up the worktree, feeding the breaker, kicking the
/// coordinator).
async fn handle_event(app: &AppHandle, event: Value) {
    let orch = app.state::<Orchestrator>();
    let store = app.state::<TaskStore>();

    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    let session_id = event.get("sessionId").and_then(Value::as_u64);

    // Correlate the event to its task. The first sighting of a session id binds it
    // to the task at the front of the pending-launch FIFO; later events read back
    // the binding. An uncorrelatable event (no pending launch) is dropped.
    let Some(task_id) = session_id.and_then(|sid| orch.provider.correlate(sid)) else {
        return;
    };

    // Forward the raw event to the webview tagged with its task.
    let _ = app.emit(
        SESSION_EVENT,
        serde_json::json!({ "taskId": task_id, "event": event }),
    );

    // M3: a permission request is relayed, not auto-denied. The plan gate
    // (`ExitPlanMode`) transitions the task to `waiting_approval` and stores the
    // plan; any other tool surfaces an interactive `nc:permission` prompt. Both
    // park in the engine until `respond_permission` (or a fail-closed deny on
    // cancel) resolves them.
    if event_type == "permission-required" {
        if let Some(request_id) = event.get("requestId").and_then(Value::as_str) {
            let tool_name = event.get("toolName").and_then(Value::as_str).unwrap_or("");
            // Relay by tool NAME only — never the input args (paths/commands/secrets).
            tracing::info!(target: "nightcore", task_id, tool = tool_name, "relaying permission request");
            orch.permissions.register(&task_id, request_id);
            if tool_name == EXIT_PLAN_MODE {
                handle_plan_gate(app, &store, &task_id, &event);
            } else {
                emit_permission_prompt(app, &task_id, request_id, &event);
            }
        }
        return;
    }

    match event_type {
        "session-started" | "session-ready" => {
            if let Some(sid) = session_id {
                tracing::info!(target: "nightcore", task_id, session_id = sid, "session ready");
                apply_and_emit(app, &store, &task_id, |task| {
                    task.session_id = Some(sid);
                });
            }
        }
        "session-completed" => {
            let result = event
                .get("result")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let cost = event.get("costUsd").and_then(Value::as_f64);
            // The phase discriminator: a completion while `Verifying` is the
            // reviewer finishing; otherwise it is a build (or fix-build) finishing.
            let status = store.get(&task_id).map(|t| t.status);
            if status == Some(TaskStatus::Verifying) {
                handle_review_completed(app, &store, &task_id, session_id, result, cost).await;
            } else {
                handle_build_completed(app, &store, &task_id, session_id, result, cost).await;
            }
        }
        "session-failed" => {
            // A user-initiated cancel or a circuit-breaker pause interrupts the run
            // and surfaces as `session-failed { reason: "aborted" }`. An abort is
            // not a "broken setup" signal, so it must NOT count toward the breaker
            // (otherwise cancelling a few tasks would trip it).
            let aborted = event.get("reason").and_then(Value::as_str) == Some("aborted");
            let message = event
                .get("message")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let was_verifying = store.get(&task_id).map(|t| t.status) == Some(TaskStatus::Verifying);

            if was_verifying && !aborted {
                // A genuine reviewer/fix crash makes verification inconclusive: park
                // for human approval (don't feed the breaker — a review crash is not
                // a broken build setup), retain the worktree for inspection (M4 §B).
                tracing::warn!(target: "nightcore", task_id, session_id = ?session_id, "reviewer/fix run crashed; parking for approval");
                apply_and_emit(app, &store, &task_id, |task| {
                    task.status = TaskStatus::WaitingApproval;
                    task.verified = false;
                    task.error = message.clone();
                    task.session_id = session_id;
                });
                park_for_approval(app, &task_id, session_id);
            } else {
                apply_and_emit(app, &store, &task_id, |task| {
                    task.status = TaskStatus::Failed;
                    task.error = message.clone();
                    task.session_id = session_id;
                });
                let outcome = if aborted {
                    tracing::info!(target: "nightcore", task_id, session_id = ?session_id, "run aborted");
                    Outcome::Aborted
                } else {
                    tracing::error!(target: "nightcore", task_id, session_id = ?session_id, error = message.as_deref().unwrap_or("<none>"), "run failed");
                    Outcome::Failed
                };
                finish_run(app, &task_id, session_id, outcome);
            }
        }
        _ => {}
    }
}

/// A build (or fix-build) session completed (M4 §B step 1). If the task's kind is
/// not verified-after — or there is no worktree to diff — finish exactly as M3
/// (`Done`, `finish_run(Succeeded)`). Otherwise enter the verification gate: set
/// `Verifying`, hold the slot+worktree, and dispatch a reviewer session over the
/// same worktree.
async fn handle_build_completed(
    app: &AppHandle,
    store: &TaskStore,
    task_id: &str,
    session_id: Option<u64>,
    result: Option<String>,
    cost: Option<f64>,
) {
    let Some(task) = store.get(task_id) else {
        return;
    };
    let verify_after = kind::policy(task.kind).verify_after;
    let worktree_dir = verification_worktree(app, task_id);

    if !verify_after || worktree_dir.is_none() {
        // M3 behavior: nothing to verify (no policy, or no worktree to diff).
        tracing::info!(target: "nightcore", task_id, session_id = ?session_id, cost_usd = ?cost, "task done (no verification)");
        apply_and_emit(app, store, task_id, |task| {
            task.status = TaskStatus::Done;
            task.summary = result.clone();
            task.cost_usd = cost;
            task.session_id = session_id;
            task.error = None;
        });
        finish_run(app, task_id, session_id, Outcome::Succeeded);
        return;
    }

    let worktree_dir = worktree_dir.expect("checked is_some above");
    // Keep the slot leased and the worktree intact: only forget the build session
    // (a new reviewer session correlates to the same task via the FIFO).
    if let Some(sid) = session_id {
        app.state::<Orchestrator>().provider.forget(sid);
    }
    tracing::info!(target: "nightcore", task_id, "build complete; entering verification gate");
    apply_and_emit(app, store, task_id, |task| {
        task.status = TaskStatus::Verifying;
        task.summary = result.clone();
        task.cost_usd = cost;
        task.error = None;
    });

    if let Err(e) = dispatch_reviewer(app, task_id, &worktree_dir).await {
        // Couldn't even start the reviewer: verification is inconclusive → park.
        apply_and_emit(app, store, task_id, |task| {
            task.status = TaskStatus::WaitingApproval;
            task.verified = false;
            task.error = Some(format!("could not start reviewer: {e}"));
        });
        park_for_approval(app, task_id, None);
    }
}

/// A reviewer session completed (M4 §B step 2). Parse the verdict from its result
/// and route: PASS → Done+verified; CHANGES_REQUESTED → bounded auto-fix or park;
/// FAIL/unparseable → park for approval (fail-safe: never silently pass).
async fn handle_review_completed(
    app: &AppHandle,
    store: &TaskStore,
    task_id: &str,
    session_id: Option<u64>,
    result: Option<String>,
    cost: Option<f64>,
) {
    let review_text = result.clone().unwrap_or_default();
    let verdict = parse_verdict(&review_text);
    tracing::info!(target: "nightcore", task_id, session_id = ?session_id, verdict = ?verdict, "verification verdict parsed");

    // The reviewer session is done regardless of verdict; forget it (the slot and
    // worktree stay with the task until a true terminal).
    if let Some(sid) = session_id {
        app.state::<Orchestrator>().provider.forget(sid);
    }

    match verdict {
        Verdict::Pass => {
            tracing::info!(target: "nightcore", task_id, "verification passed; task verified and done");
            apply_and_emit(app, store, task_id, |task| {
                task.status = TaskStatus::Done;
                task.verified = true;
                task.review = Some(review_text.clone());
                if let Some(c) = cost {
                    task.cost_usd = Some(c);
                }
                task.error = None;
            });
            // NOW it is a true terminal: release slot, clean worktree per policy,
            // record breaker success.
            finish_run(app, task_id, None, Outcome::Succeeded);
        }
        Verdict::ChangesRequested => {
            let attempts = store.get(task_id).map(|t| t.fix_attempts).unwrap_or(0);
            if attempts < MAX_FIX_ATTEMPTS {
                let worktree_dir = verification_worktree(app, task_id);
                let Some(worktree_dir) = worktree_dir else {
                    // No worktree to fix in: park.
                    park_changes_exhausted(app, store, task_id, &review_text);
                    return;
                };
                tracing::info!(target: "nightcore", task_id, attempt = attempts + 1, max = MAX_FIX_ATTEMPTS, "changes requested; dispatching auto-fix");
                apply_and_emit(app, store, task_id, |task| {
                    task.fix_attempts += 1;
                    task.status = TaskStatus::InProgress;
                    task.review = Some(review_text.clone());
                    task.error = None;
                });
                if let Err(e) = dispatch_fix(app, task_id, &review_text, &worktree_dir).await {
                    apply_and_emit(app, store, task_id, |task| {
                        task.status = TaskStatus::WaitingApproval;
                        task.verified = false;
                        task.error = Some(format!("could not start fix run: {e}"));
                    });
                    park_for_approval(app, task_id, None);
                }
            } else {
                park_changes_exhausted(app, store, task_id, &review_text);
            }
        }
        Verdict::Fail => {
            tracing::warn!(target: "nightcore", task_id, "verification failed; parking for approval");
            apply_and_emit(app, store, task_id, |task| {
                task.status = TaskStatus::WaitingApproval;
                task.verified = false;
                task.review = Some(review_text.clone());
            });
            park_for_approval(app, task_id, None);
        }
    }
}

/// Park a task whose auto-fix budget is exhausted: WaitingApproval, keep the
/// review with an exhaustion note appended so the UI surfaces it (M4 §E).
fn park_changes_exhausted(app: &AppHandle, store: &TaskStore, task_id: &str, review_text: &str) {
    tracing::warn!(target: "nightcore", task_id, max = MAX_FIX_ATTEMPTS, "auto-fix budget exhausted; parking for approval");
    let note = format!("{review_text}\n\n[auto-fix budget exhausted]");
    apply_and_emit(app, store, task_id, |task| {
        task.status = TaskStatus::WaitingApproval;
        task.verified = false;
        task.review = Some(note.clone());
    });
    park_for_approval(app, task_id, None);
}

/// The verdict an independent reviewer returned. Parsed from its final message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    ChangesRequested,
    Fail,
}

/// Parse the machine-readable verdict from a reviewer's result text. The reviewer
/// is instructed to end with a single `VERDICT: PASS|CHANGES_REQUESTED|FAIL` line;
/// we grep for the last match (the final verdict wins). No token ⇒ `Fail`
/// (fail-safe: never silently pass).
pub fn parse_verdict(text: &str) -> Verdict {
    let mut found: Option<Verdict> = None;
    for line in text.lines() {
        if let Some(rest) = line.split_once("VERDICT:") {
            let token = rest.1.trim();
            let verdict = if token.starts_with("PASS") {
                Some(Verdict::Pass)
            } else if token.starts_with("CHANGES_REQUESTED") {
                Some(Verdict::ChangesRequested)
            } else if token.starts_with("FAIL") {
                Some(Verdict::Fail)
            } else {
                None
            };
            if let Some(v) = verdict {
                found = Some(v); // last match wins
            }
        }
    }
    found.unwrap_or(Verdict::Fail)
}

/// The task's worktree dir for the verification gate, if there is an active
/// project and the worktree exists on disk. `None` ⇒ nothing to diff.
fn verification_worktree(app: &AppHandle, task_id: &str) -> Option<PathBuf> {
    let project = app.state::<ProjectStore>().active()?;
    let dir = worktree::worktree_path(&PathBuf::from(&project.path), task_id);
    dir.exists().then_some(dir)
}

/// Dispatch the read-only reviewer session over the build's worktree (M4 §B). The
/// reviewer correlates to the same task via the FIFO; its agent identity is the
/// engine's `review` preset, its per-run instructions (which diff, the base
/// branch, the verdict format) are this core-owned prompt.
pub(crate) async fn dispatch_reviewer_for(
    app: &AppHandle,
    task_id: &str,
    worktree_dir: &Path,
) -> Result<(), String> {
    dispatch_reviewer(app, task_id, worktree_dir).await
}

async fn dispatch_reviewer(
    app: &AppHandle,
    task_id: &str,
    worktree_dir: &Path,
) -> Result<(), String> {
    let orch = app.state::<Orchestrator>();
    let store = app.state::<TaskStore>();
    let task = store.get(task_id).ok_or("task vanished before review")?;
    let base = reviewer_base_branch(app);
    tracing::info!(target: "nightcore", task_id, base = %base, "dispatching reviewer over worktree");
    let prompt = reviewer_prompt(&task, &base);
    // Reviewer model: V4 reviewer-model policy is deferred to M5; use the task's
    // model (None ⇒ core default), so the reviewer is a peer of the builder.
    orch.provider
        .start_session(
            task_id,
            prompt,
            task.model.clone(),
            Some(worktree_dir.to_path_buf()),
            // The review preset's `dontAsk` default applies (no explicit override).
            None,
            TaskKind::Review.as_wire(),
        )
        .await
}

/// Dispatch a fix-build session for a `CHANGES_REQUESTED` verdict (M4 §B). Same
/// worktree as the build, `kind=build`, prompt = the original task prompt plus the
/// reviewer's change list. Its completion re-enters the build-completed path.
async fn dispatch_fix(
    app: &AppHandle,
    task_id: &str,
    review_text: &str,
    worktree_dir: &Path,
) -> Result<(), String> {
    let orch = app.state::<Orchestrator>();
    let store = app.state::<TaskStore>();
    let task = store.get(task_id).ok_or("task vanished before fix")?;
    let prompt = format!(
        "{}\n\n--- A reviewer requested changes ---\n{}",
        task.prompt(),
        review_text
    );
    let permission_mode = resolve_permission_mode(app);
    orch.provider
        .start_session(
            task_id,
            prompt,
            task.model.clone(),
            Some(worktree_dir.to_path_buf()),
            permission_mode,
            TaskKind::Build.as_wire(),
        )
        .await
}

/// The base branch the reviewer diffs against — the active project's base (the
/// same base `merge.rs` merges into). Falls back to `main` without a project.
fn reviewer_base_branch(app: &AppHandle) -> String {
    match app.state::<ProjectStore>().active() {
        Some(project) => worktree::base_branch(&PathBuf::from(&project.path)),
        None => "main".to_string(),
    }
}

/// The per-run reviewer prompt (core-owned). Instructs the read-only reviewer to
/// inspect all worktree changes relative to `base`, judge them against the task,
/// and end with the single machine-readable `VERDICT:` line the core greps for.
fn reviewer_prompt(task: &Task, base: &str) -> String {
    format!(
        "Review the changes in this worktree, which implement the task below.\n\n\
         Task:\n{task_prompt}\n\n\
         Inspect ALL changes relative to base branch `{base}`: run `git status`, \
         `git diff {base}...HEAD`, and check untracked files. Judge correctness and \
         completeness against the task.\n\n\
         End your final message with a single line that is exactly one of:\n\
         VERDICT: PASS\n\
         VERDICT: CHANGES_REQUESTED\n\
         VERDICT: FAIL\n\n\
         Put your rationale above that line. For CHANGES_REQUESTED, include a \
         numbered list of the changes needed.",
        task_prompt = task.prompt(),
        base = base,
    )
}

/// Surface an interactive permission prompt to the webview as `nc:permission`.
/// Forwards the tool name + input (which may contain paths/commands — never
/// logged) plus the SDK's `suggestions`, when present, so the UI can offer
/// pre-filled allow/deny choices.
fn emit_permission_prompt(app: &AppHandle, task_id: &str, request_id: &str, event: &Value) {
    let _ = app.emit(
        PERMISSION_EVENT,
        serde_json::json!({
            "taskId": task_id,
            "requestId": request_id,
            "toolName": event.get("toolName").and_then(Value::as_str).unwrap_or(""),
            "input": event.get("input").cloned().unwrap_or(Value::Null),
            "suggestions": event.get("suggestions").cloned(),
        }),
    );
}

/// The plan-approval gate (M3 §C): the agent finished a plan in `plan` mode and
/// called `ExitPlanMode`, surfacing as a `permission-required`. Transition the task
/// to `waiting_approval` and store the plan (from the tool input) so the detail
/// panel renders it; the parked request resolves later via `approve_task` /
/// `reject_task` / `refine_task`.
fn handle_plan_gate(app: &AppHandle, store: &TaskStore, task_id: &str, event: &Value) {
    let plan = extract_plan(event);
    apply_and_emit(app, store, task_id, |task| {
        task.status = TaskStatus::WaitingApproval;
        task.plan = plan.clone();
    });
}

/// Pull the plan text out of an `ExitPlanMode` tool input. The SDK passes the plan
/// under `input.plan`; fall back to the whole input rendered as a string so the UI
/// always has something to show.
fn extract_plan(event: &Value) -> Option<String> {
    let input = event.get("input")?;
    if let Some(plan) = input.get("plan").and_then(Value::as_str) {
        return Some(plan.to_string());
    }
    Some(input.to_string())
}

/// How a run ended, for terminal bookkeeping.
enum Outcome {
    /// `session-completed`: clean up the worktree (per policy), reset the breaker.
    Succeeded,
    /// `session-failed` (genuine): retain the worktree, feed the breaker.
    Failed,
    /// `session-failed { reason: "aborted" }` (cancel / circuit-break): retain the
    /// worktree, but do NOT count toward the breaker.
    Aborted,
    /// M4: a verification gate terminal that parks the task for human approval
    /// (FAIL / auto-fix budget exhausted / inconclusive). Releases the slot and
    /// forgets the session, but RETAINS the worktree for inspection and does NOT
    /// feed the breaker (a CHANGES_REQUESTED the agent couldn't fix, or a review
    /// crash, is not a broken build setup). See [`park_for_approval`].
    #[allow(dead_code)]
    NeedsApproval,
}

/// A verification gate terminal (M4 §B "holding"): release the slot, forget the
/// session, RETAIN the worktree (the user will inspect/approve it), do NOT feed
/// the breaker, then kick the coordinator. Distinct from [`finish_run`], which
/// would clean the worktree and touch the breaker.
fn park_for_approval(app: &AppHandle, task_id: &str, session_id: Option<u64>) {
    let orch = app.state::<Orchestrator>();
    orch.slots.release(task_id);
    let _ = orch.permissions.drain_task(task_id);
    if let Some(sid) = session_id {
        orch.provider.forget(sid);
    }
    // Worktree is intentionally retained; the breaker is intentionally untouched.
    orch.kick();
}

/// A run reached a terminal state: release its slot, drop the correlation binding,
/// clean up the worktree (per policy), feed the circuit breaker, and kick the
/// coordinator so the board drains without waiting a full interval.
fn finish_run(app: &AppHandle, task_id: &str, session_id: Option<u64>, outcome: Outcome) {
    let orch = app.state::<Orchestrator>();
    orch.slots.release(task_id);
    // Any permission request still parked for this run is moot: the session has
    // reached a terminal state and the engine's own teardown denies its SDK control
    // request. Drop our registry entries so they can't leak across reruns.
    let _ = orch.permissions.drain_task(task_id);
    if let Some(sid) = session_id {
        orch.provider.forget(sid);
    }
    coordinator::cleanup_worktree(app, task_id, matches!(outcome, Outcome::Succeeded));
    match outcome {
        Outcome::Succeeded => orch.breaker.record_success(),
        // Routed through `park_for_approval`, never here; handled for exhaustiveness.
        Outcome::Aborted | Outcome::NeedsApproval => {} // not a failure signal
        Outcome::Failed => {
            if orch.breaker.record_failure() {
                // This failure tripped the breaker: interrupt the rest and pause.
                tracing::warn!(target: "nightcore", task_id, threshold = orch.breaker.threshold(), "circuit breaker tripped; pausing auto-loop");
                orch.emit_state(app, "paused", Some("circuit-breaker"));
                let app = app.clone();
                tokio::spawn(async move {
                    app.state::<Orchestrator>().interrupt_all().await;
                });
            }
        }
    }
    orch.kick();
}

/// Mutate a task, persist, and emit `nc:task`.
fn apply_and_emit<F>(app: &AppHandle, store: &TaskStore, id: &str, f: F)
where
    F: FnOnce(&mut Task),
{
    match store.mutate(id, f) {
        Ok(task) => {
            let _ = app.emit(TASK_EVENT, &task);
        }
        Err(e) => tracing::error!(target: "nightcore", task_id = id, error = %e, "failed to finalize task"),
    }
}

// --- Commands ---------------------------------------------------------------

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
    let task = store.get(&id).ok_or_else(|| format!("no task with id {id}"))?;

    // Lease a slot. With concurrency 1 this reproduces M1's "a task is already
    // running" rejection exactly.
    if !orch.slots.try_lease(&id) {
        return Err("no free slot (max concurrency reached)".to_string());
    }

    let cwd = match resolve_worktree(&app, &id) {
        Ok(cwd) => cwd,
        Err(e) => {
            orch.slots.release(&id);
            return Err(e);
        }
    };

    let updated = match store.mutate(&id, |task| {
        task.status = TaskStatus::InProgress;
        task.summary = None;
        task.error = None;
        // A fresh run clears the prior verification verdict (M4 §B).
        task.verified = false;
        task.review = None;
        task.fix_attempts = 0;
    }) {
        Ok(task) => task,
        Err(e) => {
            orch.slots.release(&id);
            return Err(e);
        }
    };
    let _ = app.emit(TASK_EVENT, &updated);

    if let Err(e) = ensure_reader(&app).await {
        orch.slots.release(&id);
        return Err(e);
    }

    let permission_mode = resolve_permission_mode(&app);
    if let Err(e) = orch
        .provider
        .start_session(
            &id,
            task.prompt(),
            task.model.clone(),
            cwd,
            permission_mode,
            task.kind.as_wire(),
        )
        .await
    {
        orch.slots.release(&id);
        return Err(e);
    }

    Ok(())
}

/// The SDK permission mode for the next run, resolved from settings (per-project
/// override, else global) and mapped to the engine's mode. Shared by the manual
/// `run_task` path and the coordinator's auto-loop launch so both honor the mode.
pub fn resolve_permission_mode(app: &AppHandle) -> Option<String> {
    use crate::settings::SettingsStore;
    let settings = app.state::<SettingsStore>();
    let project_id = app
        .state::<ProjectStore>()
        .active()
        .map(|p| p.id);
    Some(settings.sdk_permission_mode(project_id.as_deref()))
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
        "allow" => PermissionDecision::Allow {
            updated_input,
        },
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
    }
    Ok(())
}

/// Resolve the worktree cwd for a manual run, mirroring the coordinator's logic so
/// `run_task` and the loop isolate runs identically. `Ok(None)` = run in the
/// workspace root (no active project).
fn resolve_worktree(app: &AppHandle, task_id: &str) -> Result<Option<PathBuf>, String> {
    let projects = app.state::<ProjectStore>();
    let Some(project) = projects.active() else {
        return Ok(None);
    };
    let project_path = PathBuf::from(&project.path);
    if !worktree::is_worktree_clean(&project_path).unwrap_or(true) {
        return Err(format!(
            "base working tree at {} is dirty; commit or stash before running",
            project_path.display()
        ));
    }
    let dir = worktree::allocate(&project_path, task_id)?;
    Ok(Some(dir))
}

#[cfg(test)]
mod tests {
    use super::{parse_verdict, Verdict};
    use crate::m2::slots::SlotManager;

    #[test]
    fn verdict_parses_each_token() {
        assert_eq!(parse_verdict("ok\nVERDICT: PASS"), Verdict::Pass);
        assert_eq!(
            parse_verdict("VERDICT: CHANGES_REQUESTED"),
            Verdict::ChangesRequested
        );
        assert_eq!(parse_verdict("VERDICT: FAIL"), Verdict::Fail);
    }

    #[test]
    fn verdict_last_match_wins() {
        // A reviewer that mentions an earlier verdict then concludes with another:
        // the final line is authoritative.
        let text = "first I thought VERDICT: FAIL\nbut actually\nVERDICT: PASS";
        assert_eq!(parse_verdict(text), Verdict::Pass);
    }

    #[test]
    fn verdict_tolerates_trailing_rationale_on_the_line() {
        assert_eq!(parse_verdict("VERDICT: PASS — looks good"), Verdict::Pass);
    }

    #[test]
    fn no_verdict_token_fails_safe() {
        // Fail-safe: an unparseable / token-less review never silently passes.
        assert_eq!(parse_verdict("I forgot to include a verdict line"), Verdict::Fail);
        assert_eq!(parse_verdict(""), Verdict::Fail);
        assert_eq!(parse_verdict("VERDICT: MAYBE"), Verdict::Fail);
    }

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
