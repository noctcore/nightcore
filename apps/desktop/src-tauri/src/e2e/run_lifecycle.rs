//! Create → run → board-state transition, composed over the real subsystems.
//!
//! This walks a task the way `run_task` → `submit_run` → the reader's terminal arm
//! does, but through the `AppHandle`-free halves (real `SlotManager`, real
//! `TaskStore`, real `SidecarProvider` correlation), asserting the store status, the
//! slot accounting, and the session↔task binding stay consistent at every step. The
//! scripted fake provider supplies the `session-started`/terminal events a real
//! sidecar child would emit.

use crate::task::{RunMode, TaskKind, TaskStatus};

use super::harness::TestApp;

#[test]
fn create_run_and_complete_frees_the_slot_and_settles_done() {
    let h = TestApp::boot(1);

    // Create: a fresh task lands in Backlog with no slot held.
    let id = h.create_backlog_task(TaskKind::Research, RunMode::Main);
    assert_eq!(h.status(&id), TaskStatus::Backlog);
    assert_eq!(h.orch().slots.leased_count(), 0);

    // Run: lease + mark in-progress (the `submit_run` slot half).
    assert!(
        h.lease_and_mark_in_progress(&id),
        "a free slot admits the run"
    );
    assert_eq!(h.status(&id), TaskStatus::InProgress);
    assert_eq!(h.orch().slots.leased_count(), 1, "the run holds one slot");

    // session-started: the engine assigns session 100; the FIFO binds it to the task
    // and the reader stamps `session_id`.
    assert_eq!(
        h.script_session_started(&id, 100).as_deref(),
        Some(id.as_str()),
        "the pending launch correlates to its session"
    );
    assert_eq!(h.task(&id).session_id, Some(100));
    assert_eq!(
        h.provider().task_for(100).as_deref(),
        Some(id.as_str()),
        "the live binding is readable for a by-task interrupt"
    );

    // Terminal: the reader's completion path forgets the session, settles Done, and
    // releases the slot.
    h.script_terminal_done(&id, 100, Some(0.42));
    let done = h.task(&id);
    assert_eq!(done.status, TaskStatus::Done);
    assert_eq!(done.cost_usd, Some(0.42), "the run cost is persisted");
    assert_eq!(
        h.orch().slots.leased_count(),
        0,
        "the terminal event freed the slot"
    );
    assert!(
        h.provider().task_for(100).is_none(),
        "the terminal forgot the session binding"
    );
}

#[test]
fn a_freed_slot_admits_the_next_run_at_max_one() {
    // The M1 serial guard through the full lifecycle: at max=1 a second run is refused
    // while the first holds the slot, and admitted only after its terminal frees it.
    let h = TestApp::boot(1);
    let first = h.create_backlog_task(TaskKind::Research, RunMode::Main);
    let second = h.create_backlog_task(TaskKind::Research, RunMode::Main);

    assert!(h.lease_and_mark_in_progress(&first));
    assert!(
        !h.lease_and_mark_in_progress(&second),
        "no free slot while the first run is in flight (serial guard)"
    );
    assert_eq!(
        h.status(&second),
        TaskStatus::Backlog,
        "the refused run never left backlog"
    );

    h.script_session_started(&first, 1);
    h.script_terminal_done(&first, 1, None);
    assert!(
        h.lease_and_mark_in_progress(&second),
        "the freed slot admits the next run"
    );
    assert_eq!(h.status(&second), TaskStatus::InProgress);
}

#[test]
fn two_runs_share_a_two_slot_pool_without_cross_binding() {
    // True M2 concurrency: two tasks launched before either session-started arrives
    // bind in FIFO order and settle independently — no cross-wiring of sessions or
    // slots.
    let h = TestApp::boot(2);
    let a = h.create_backlog_task(TaskKind::Research, RunMode::Main);
    let b = h.create_backlog_task(TaskKind::Research, RunMode::Main);

    assert!(h.lease_and_mark_in_progress(&a));
    assert!(h.lease_and_mark_in_progress(&b));
    assert_eq!(h.orch().slots.leased_count(), 2, "both slots leased");

    // Sessions arrive interleaved; the FIFO binds a→10, b→11 by launch order.
    assert_eq!(
        h.script_session_started(&a, 10).as_deref(),
        Some(a.as_str())
    );
    assert_eq!(
        h.script_session_started(&b, 11).as_deref(),
        Some(b.as_str())
    );
    assert_eq!(h.task(&a).session_id, Some(10));
    assert_eq!(h.task(&b).session_id, Some(11));

    // b finishes first; only b's slot frees and only b settles Done.
    h.script_terminal_done(&b, 11, None);
    assert_eq!(h.status(&b), TaskStatus::Done);
    assert_eq!(
        h.status(&a),
        TaskStatus::InProgress,
        "a is untouched by b's terminal"
    );
    assert_eq!(h.orch().slots.leased_count(), 1, "a still holds its slot");

    h.script_terminal_done(&a, 10, None);
    assert_eq!(h.orch().slots.leased_count(), 0);
}
