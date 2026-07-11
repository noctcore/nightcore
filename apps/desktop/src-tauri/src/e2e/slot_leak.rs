//! The cancel→re-run **slot-leak** critical (2026-06-29 production audit), composed
//! over the real subsystems.
//!
//! The bug class: a task is cancelled and immediately re-run; the re-run binds a NEW
//! session before the OLD session's terminal event lands. If the reader acted on the
//! stale terminal, `finish_run` would release the NEW run's slot — launching past
//! `max_concurrency` and stranding the live run. The fix (`sidecar::reader`) is
//! `is_stale_terminal`: a terminal whose session id differs from the task's currently
//! bound session is dropped (only the session forgotten), and the slot is left with
//! the live run. This scenario reproduces the exact interaction — real
//! `SidecarProvider` correlation + real `SlotManager` + real `TaskStore` — and
//! asserts no slot leaks.

use crate::task::{RunMode, TaskKind, TaskStatus};

use super::harness::TestApp;

/// The stale-terminal predicate the reader (`sidecar::reader::is_stale_terminal`)
/// applies: a terminal is stale when the task is currently bound to a *different*
/// session than the one the event carries. Restated here (the reader's copy is
/// private to the `sidecar` module) so the scenario grounds its drop decision in the
/// same rule; if the reader's rule changes, this comment is the drift flag.
fn is_stale_terminal(event_session: u64, current_session: Option<u64>) -> bool {
    matches!(current_session, Some(c) if c != event_session)
}

#[test]
fn stale_terminal_after_cancel_rerun_does_not_leak_the_reruns_slot() {
    let h = TestApp::boot(1);
    let id = h.create_backlog_task(TaskKind::Build, RunMode::Worktree);

    // First run: leases the only slot, binds session 10.
    assert!(h.lease_and_mark_in_progress(&id));
    assert_eq!(
        h.script_session_started(&id, 10).as_deref(),
        Some(id.as_str())
    );
    assert_eq!(h.task(&id).session_id, Some(10));

    // Cancel keeps the slot leased until the run's terminal lands (the fix's other
    // half: `cancel_task` no longer releases eagerly, so a cancel→re-run can't
    // cross-wire a stale terminal onto the new run). The interrupt is in flight; no
    // terminal has arrived yet, so the slot is still held.
    assert_eq!(
        h.orch().slots.leased_count(),
        1,
        "cancel keeps the slot until terminal"
    );

    // Re-run binds a NEW session 11 to the SAME task (the slot was never freed, so at
    // max=1 the re-run reuses the held lease — mark-in-progress again, new session).
    h.store()
        .mutate(&id, |t| t.status = TaskStatus::InProgress)
        .unwrap();
    assert_eq!(
        h.script_session_started(&id, 11).as_deref(),
        Some(id.as_str())
    );
    assert_eq!(
        h.task(&id).session_id,
        Some(11),
        "the task is now bound to the re-run"
    );

    // The STALE terminal for the superseded session 10 arrives. The reader drops it:
    // it is stale (bound session is 11, not 10), so it forgets ONLY session 10 and
    // leaves the slot with the live run.
    let bound = h.task(&id).session_id;
    assert!(
        is_stale_terminal(10, bound),
        "session 10's terminal is stale — the task moved on to 11"
    );
    h.provider().forget(10); // the reader's stale-drop action — NOT a slot release
    assert_eq!(
        h.orch().slots.leased_count(),
        1,
        "the stale terminal must NOT release the live re-run's slot (the leak)"
    );
    assert_eq!(
        h.status(&id),
        TaskStatus::InProgress,
        "the live run is untouched"
    );
    assert_eq!(
        h.provider().task_for(11).as_deref(),
        Some(id.as_str()),
        "the live session 11 binding survives the stale drop"
    );

    // The LIVE terminal for session 11 settles normally and frees the slot.
    assert!(
        !is_stale_terminal(11, h.task(&id).session_id),
        "session 11 is the live run"
    );
    h.script_terminal_done(&id, 11, None);
    assert_eq!(
        h.orch().slots.leased_count(),
        0,
        "the live terminal frees the slot"
    );
    assert_eq!(h.status(&id), TaskStatus::Done);
}

#[test]
fn a_stale_terminal_never_clobbers_the_live_runs_slot_under_concurrency() {
    // The leak's real danger is exceeding `max_concurrency`: acting on a stale
    // terminal releases a slot the live run still needs, admitting an extra run. With
    // two tasks filling a 2-slot pool, dropping a stale terminal must keep both slots
    // held so no third run can sneak in.
    let h = TestApp::boot(2);
    let a = h.create_backlog_task(TaskKind::Build, RunMode::Worktree);
    let b = h.create_backlog_task(TaskKind::Build, RunMode::Worktree);
    let c = h.create_backlog_task(TaskKind::Build, RunMode::Worktree);

    assert!(h.lease_and_mark_in_progress(&a));
    assert!(h.lease_and_mark_in_progress(&b));
    h.script_session_started(&a, 20);
    h.script_session_started(&b, 21);

    // `a` is cancelled + re-run onto session 22 (slot kept throughout).
    h.store()
        .mutate(&a, |t| t.status = TaskStatus::InProgress)
        .unwrap();
    h.script_session_started(&a, 22);

    // `a`'s stale terminal (session 20) arrives — dropped, slot NOT freed.
    assert!(is_stale_terminal(20, h.task(&a).session_id));
    h.provider().forget(20);
    assert_eq!(h.orch().slots.leased_count(), 2, "both slots still held");
    assert!(
        !h.lease_and_mark_in_progress(&c),
        "the pool is still full — the stale drop admitted no extra run"
    );
    assert_eq!(h.status(&c), TaskStatus::Backlog);
}
