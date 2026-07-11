//! The FAILURE half of the run lifecycle + the circuit breaker, composed over the
//! real subsystems.
//!
//! [`run_lifecycle`](super::run_lifecycle) walks the SUCCESS path (a run settling
//! `Done` and freeing its slot). This module walks the complementary failure branch —
//! the reader's `session-failed` arm settling a run `Failed` and `finish_run` feeding
//! the [`CircuitBreaker`](crate::orchestration::breaker) — which the success-only
//! scenarios never exercise. It asserts the two invariants that matter on this path:
//! a failed terminal frees its slot (no leak on failure, the mirror of the slot-leak
//! critical) and the breaker trips on exactly the failures that signal a broken setup
//! — a windowed threshold of transient failures, or a single fatal-setup failure —
//! while a clean run clears the window and a user abort is spared.
//!
//! The breaker feed in the real reader path is AppHandle-bound (it crosses the
//! `EngineApi` trait — `engine.breaker_record_*(app)`), but `EngineHandle` delegates
//! each call verbatim to the orchestrator's own `breaker.record_*()` (an
//! `AppHandle`-free `CircuitBreaker` field), so the harness composes that exact call —
//! the same restatement idiom [`slot_leak`](super::slot_leak) uses for the reader's
//! private `is_stale_terminal`. If `finish_run`'s per-`Outcome` breaker branch
//! changes, these helpers (in [`harness`](super::harness)) are the drift flag.

use crate::task::{RunMode, TaskKind, TaskStatus};

use super::harness::TestApp;

#[test]
fn a_failed_run_settles_failed_frees_its_slot_and_forgets_the_session() {
    let h = TestApp::boot(1);
    let id = h.create_backlog_task(TaskKind::Build, RunMode::Worktree);

    assert!(h.lease_and_mark_in_progress(&id));
    assert_eq!(
        h.script_session_started(&id, 1).as_deref(),
        Some(id.as_str())
    );
    assert_eq!(h.orch().slots.leased_count(), 1);

    // The run fails. The reader settles the task `Failed` with the error, forgets the
    // session, releases the slot, and feeds the breaker one windowed failure.
    let tripped = h.script_terminal_failed(&id, 1, "boom");
    assert!(!tripped, "one failure is below the default threshold (3)");

    let t = h.task(&id);
    assert_eq!(t.status, TaskStatus::Failed);
    assert_eq!(
        t.error.as_deref(),
        Some("boom"),
        "the failure reason is persisted"
    );
    assert_eq!(
        h.orch().slots.leased_count(),
        0,
        "the failed terminal freed the slot (no leak on the failure path)"
    );
    assert!(
        h.provider().task_for(1).is_none(),
        "the failed terminal forgot the session binding"
    );
    assert!(
        !h.orch().breaker.is_paused(),
        "one failure does not pause the loop"
    );
}

#[test]
fn consecutive_failures_at_the_threshold_trip_the_breaker_and_pause_the_loop() {
    // The default breaker threshold is 3. Three runs that each reach a genuine failure
    // terminal within the window trip it; the coordinator tick is gated on
    // `!breaker.is_paused()`, so a tripped breaker stops the auto-loop from burning the
    // rest of the board under the same broken cause.
    let h = TestApp::boot(3);
    let ids: Vec<String> = (0..3)
        .map(|_| h.create_backlog_task(TaskKind::Build, RunMode::Worktree))
        .collect();

    let mut tripped_on = None;
    for (i, id) in ids.iter().enumerate() {
        let session = 100 + i as u64;
        assert!(h.lease_and_mark_in_progress(id));
        h.script_session_started(id, session);
        if h.script_terminal_failed(id, session, "setup broken") {
            tripped_on = Some(i);
        }
    }

    assert_eq!(
        tripped_on,
        Some(2),
        "the third consecutive failure is the one that trips the breaker"
    );
    assert!(h.orch().breaker.is_paused(), "the auto-loop is now paused");
    assert_eq!(
        h.orch().slots.leased_count(),
        0,
        "every failed run released its slot — the failure path leaks none"
    );
    for id in &ids {
        assert_eq!(h.status(id), TaskStatus::Failed);
    }
}

#[test]
fn a_success_between_failures_clears_the_window_so_intermittent_failures_hold() {
    // A clean run resets the breaker's failure window (`finish_run`'s `Succeeded`
    // arm), so failures separated by a success never accumulate to the threshold.
    // fail, fail, SUCCEED, fail, fail = only two consecutive post-success failures ⇒
    // no trip.
    let h = TestApp::boot(1);

    // One serial run at max=1: the terminal releases the slot, so the next run leases.
    fn run(h: &TestApp, session: u64, ok: bool) {
        let id = h.create_backlog_task(TaskKind::Build, RunMode::Worktree);
        assert!(h.lease_and_mark_in_progress(&id));
        h.script_session_started(&id, session);
        if ok {
            h.script_terminal_done(&id, session, None);
        } else {
            h.script_terminal_failed(&id, session, "flaky");
        }
    }

    run(&h, 1, false);
    run(&h, 2, false);
    run(&h, 3, true); // the clean run clears the accumulated window
    run(&h, 4, false);
    run(&h, 5, false);

    assert!(
        !h.orch().breaker.is_paused(),
        "two post-success failures stay under the threshold — the loop holds"
    );
}

#[test]
fn a_fatal_setup_failure_trips_the_breaker_on_the_first_hit() {
    // A structured auth/disk-full failure (`is_fatal_setup_failure`) must stop the
    // loop AT ONCE — before the tolerant window's threshold — so the board doesn't burn
    // two more tasks under the same broken credential. `finish_run` routes it to
    // `record_fatal_failure`.
    let h = TestApp::boot(2);
    let id = h.create_backlog_task(TaskKind::Build, RunMode::Worktree);
    assert!(h.lease_and_mark_in_progress(&id));
    h.script_session_started(&id, 1);

    let tripped = h.script_terminal_fatal(&id, 1, "authentication");
    assert!(tripped, "the first fatal failure trips the breaker");
    assert!(
        h.orch().breaker.is_paused(),
        "the loop is paused immediately, below the transient threshold"
    );
    assert_eq!(h.status(&id), TaskStatus::Failed);
    assert_eq!(
        h.orch().slots.leased_count(),
        0,
        "the fatal terminal still freed the slot"
    );
}

#[test]
fn aborted_runs_never_feed_the_breaker() {
    // A user cancel / circuit-break surfaces as `session-failed { reason: "aborted" }`;
    // `finish_run`'s `Aborted` arm settles the task `Failed` and frees the slot but must
    // NOT count toward the breaker (otherwise cancelling a handful of tasks would trip
    // it). Well past the threshold of aborts, the loop stays live.
    let h = TestApp::boot(1);
    for session in 0..5u64 {
        let id = h.create_backlog_task(TaskKind::Build, RunMode::Worktree);
        assert!(h.lease_and_mark_in_progress(&id));
        h.script_session_started(&id, session);
        h.script_terminal_aborted(&id, session);
        assert_eq!(h.status(&id), TaskStatus::Failed);
    }
    assert!(
        !h.orch().breaker.is_paused(),
        "five aborts never trip the breaker — a cancel is not a broken-setup signal"
    );
    assert_eq!(
        h.orch().slots.leased_count(),
        0,
        "every aborted run freed its slot"
    );
}
