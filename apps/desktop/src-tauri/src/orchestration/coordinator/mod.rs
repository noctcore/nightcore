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

mod auto_loop;
mod commands;
mod cwd;
mod reconcile;
mod state;
mod submit;
mod usage_gate;

// Module facade: preserve the historical `crate::orchestration::coordinator::*`
// paths after the god-file split so external call sites keep resolving unchanged
// (lib.rs's `reconcile_*`/auto-loop command paths, sidecar's `submit_run`, settings'
// `set_max_concurrency`) and the cross-submodule calls inside this folder resolve
// via `super::*`. Glob re-exports mirror the `sidecar/mod.rs` facade. The
// `commands::*` glob is REQUIRED so `generate_handler!` reaches the macro siblings.
pub(crate) use auto_loop::*;
pub(crate) use commands::*;
pub(crate) use cwd::*;
pub(crate) use reconcile::*;
pub(crate) use state::*;
pub(crate) use submit::*;
pub(crate) use usage_gate::*;

#[cfg(test)]
mod tests {
    use super::*;

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
}
