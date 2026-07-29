//! Run-order projection (board flow #402): the coordinator's REAL execution order,
//! made legible to the board.
//!
//! The board renders each column newest-updated-first, but the auto-loop launches
//! `backlog`/`ready` tasks in dependency order, oldest-`created_at` first, up to the
//! free slot count per tick ([`crate::orchestration::deps::eligible_tasks`] +
//! `auto_loop::tick`). On any board where those two orders diverge — which is every
//! board with a hand-authored dependency chain — the visual order silently misleads.
//!
//! This module projects the coordinator's own decision forward, wave by wave, using
//! the SAME primitives the tick uses (`is_launchable_status`, `deps_satisfied`, and
//! the `(created_at, id)` tiebreak) rather than a second re-implementation. Wave 0 is
//! literally what the next tick will launch — pinned by
//! [`tests::wave_zero_matches_the_tick`].
//!
//! Honesty contract: the projection assumes every pending run eventually reaches
//! `Done`. It is a projection, not a promise — a failed run re-blocks its dependents,
//! and the next fetch reflects that. A task that can NEVER become eligible (a missing
//! or `Failed` dependency, or a dependency cycle) is reported separately in
//! [`RunOrderProjection::unreachable`] instead of being given a fake position.

use std::borrow::Borrow;
use std::collections::HashSet;

use serde::Serialize;
// `ts-rs` is a dev-dependency (the Rust→TS codegen runs only under `cargo test`), so
// the derive + attributes are gated behind `cfg(test)`; the shipped binary never
// links it. The runtime `Serialize` derive stays — these ARE the IPC payload.
#[cfg(test)]
use ts_rs::TS;

use crate::orchestration::deps::{index_by_id, is_launchable_status};
use crate::task::{Task, TaskStatus};

/// One launchable task's place in the projected execution order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "RunOrderEntry.ts"))]
pub struct RunOrderEntry {
    pub task_id: String,
    /// 1-based position across the whole projection — the Nth task the loop picks up.
    pub position: u32,
    /// Which concurrency batch this task lands in. `0` is the next tick's batch (the
    /// tasks that start immediately); each later wave assumes the previous one finished.
    pub wave: u32,
    /// True when this task is in wave 0 — i.e. arming the loop right now starts it.
    pub starts_now: bool,
    /// The task's dependency ids that are NOT satisfied yet (live, not projected), so
    /// the UI can say *why* a task sits at position N. Empty for a runnable task.
    pub blocked_by: Vec<String>,
}

/// The whole projection: the ordered launchable tasks plus the slot context the order
/// was computed against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "RunOrderProjection.ts"))]
pub struct RunOrderProjection {
    /// Launchable tasks in projected execution order (position 1 first).
    pub entries: Vec<RunOrderEntry>,
    /// Launchable task ids that can never become eligible as the board stands — a
    /// dependency that is missing, `Failed`, or part of a cycle. Fail-closed, mirroring
    /// [`crate::orchestration::deps::deps_satisfied`]: these are surfaced, never ordered.
    pub unreachable: Vec<String>,
    /// Run slots free right now (`max_concurrency - leased`) — wave 0's capacity.
    pub free_slots: u32,
    /// The live concurrency cap (later waves' capacity).
    pub max_concurrency: u32,
    /// How many tasks the very next tick launches — the Auto-Mode arm preview's "this
    /// will start N tasks". Equals `entries.iter().filter(|e| e.starts_now).count()`.
    pub starts_now_count: u32,
}

/// Guard against an unbounded wave walk. The loop already terminates (each wave either
/// consumes at least one queued task or resolves the in-flight set exactly once), but a
/// hard ceiling keeps a future edit from turning a read-only command into a spin.
const MAX_WAVES: u32 = 512;

/// Project the coordinator's execution order over `tasks`.
///
/// `is_leased` is injected (as in `eligible_tasks`) so this stays a pure function that
/// unit-tests without a live `SlotManager`. `free_slots` is wave 0's capacity and
/// `max_concurrency` every later wave's.
///
/// Wave 0 is exactly `eligible_tasks(tasks, is_leased).take(free_slots)` — the tick's
/// own decision. Later waves assume each earlier wave's runs reached `Done`, plus the
/// currently in-flight runs completing at the end of wave 0.
pub fn project_run_order<T, F>(
    tasks: &[T],
    is_leased: F,
    free_slots: usize,
    max_concurrency: usize,
) -> RunOrderProjection
where
    T: Borrow<Task>,
    F: Fn(&str) -> bool,
{
    let index = index_by_id(tasks);
    // Satisfied RIGHT NOW: only `Done` counts (mirrors `deps_satisfied`). Captured once
    // as the LIVE blocker set for `blocked_by`, then cloned into the growing projection
    // set — the two must not be conflated (`blocked_by` reports today, not the forecast).
    let live_resolved: HashSet<&str> = index
        .iter()
        .filter(|(_, t)| matches!(t.status, TaskStatus::Done))
        .map(|(id, _)| id.as_str())
        .collect();
    let mut resolved = live_resolved.clone();
    // Runs the loop is already driving (a live session, a parked approval, or a held
    // lease). They occupy no projected wave — they started already — but their
    // dependents unblock once they finish, which the projection models as "end of
    // wave 0".
    let in_flight: Vec<&str> = index
        .iter()
        .filter(|(id, t)| {
            (!is_launchable_status(t.status) && !is_settled(t.status)) || is_leased(id.as_str())
        })
        .map(|(id, _)| id.as_str())
        .collect();

    // The coordinator's candidate pool, pre-sorted once by its tiebreak so every wave's
    // `retain` preserves launch order without re-sorting.
    let mut queue: Vec<&Task> = tasks
        .iter()
        .map(Borrow::borrow)
        .filter(|t| is_launchable_status(t.status))
        .filter(|t| !is_leased(&t.id))
        .collect();
    queue.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut entries: Vec<RunOrderEntry> = Vec::new();
    let mut position: u32 = 0;
    let mut wave: u32 = 0;
    while !queue.is_empty() && wave < MAX_WAVES {
        let capacity = if wave == 0 {
            free_slots
        } else {
            max_concurrency
        };
        let batch: Vec<&Task> = queue
            .iter()
            .copied()
            .filter(|t| t.dependencies.iter().all(|d| resolved.contains(d.as_str())))
            .take(capacity)
            .collect();
        // Nothing eligible AND nothing pending to unblock it ⇒ the rest is unreachable.
        // (Wave 0 with zero capacity is not a dead end: the in-flight set still resolves
        // below, so the walk continues into wave 1.)
        if batch.is_empty() && !(wave == 0 && (capacity == 0 || !in_flight.is_empty())) {
            break;
        }
        let taken: HashSet<&str> = batch.iter().map(|t| t.id.as_str()).collect();
        for task in &batch {
            position += 1;
            entries.push(RunOrderEntry {
                task_id: task.id.clone(),
                position,
                wave,
                starts_now: wave == 0,
                blocked_by: unsatisfied_deps(task, &live_resolved),
            });
        }
        queue.retain(|t| !taken.contains(t.id.as_str()));
        for id in taken {
            resolved.insert(id);
        }
        if wave == 0 {
            for id in &in_flight {
                resolved.insert(id);
            }
        }
        wave += 1;
    }

    let starts_now_count = entries.iter().filter(|e| e.starts_now).count() as u32;
    RunOrderProjection {
        entries,
        unreachable: queue.iter().map(|t| t.id.clone()).collect(),
        free_slots: free_slots as u32,
        max_concurrency: max_concurrency as u32,
        starts_now_count,
    }
}

/// Whether a status is terminal (no run will advance it on its own).
fn is_settled(status: TaskStatus) -> bool {
    matches!(status, TaskStatus::Done | TaskStatus::Failed)
}

/// A task's dependency ids that are not satisfied yet, in declaration order.
fn unsatisfied_deps(task: &Task, resolved: &HashSet<&str>) -> Vec<String> {
    task.dependencies
        .iter()
        .filter(|d| !resolved.contains(d.as_str()))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::deps::eligible_tasks;

    fn task(id: &str, status: TaskStatus, created_at: u64, deps: &[&str]) -> Task {
        let mut t = Task::new(id.to_string(), String::new());
        t.id = id.to_string();
        t.status = status;
        t.created_at = created_at;
        t.dependencies = deps.iter().map(|s| s.to_string()).collect();
        t
    }

    fn ids(projection: &RunOrderProjection) -> Vec<&str> {
        projection
            .entries
            .iter()
            .map(|e| e.task_id.as_str())
            .collect()
    }

    #[test]
    fn orders_independent_tasks_by_created_at_then_id() {
        let tasks = vec![
            task("z-older", TaskStatus::Ready, 100, &[]),
            task("a-newer", TaskStatus::Backlog, 200, &[]),
            task("a-tie", TaskStatus::Ready, 100, &[]),
        ];
        let p = project_run_order(&tasks, |_| false, 3, 3);
        assert_eq!(ids(&p), vec!["a-tie", "z-older", "a-newer"]);
        assert!(p.entries.iter().all(|e| e.wave == 0 && e.starts_now));
        assert_eq!(p.starts_now_count, 3);
        assert_eq!(p.entries[0].position, 1);
        assert_eq!(p.entries[2].position, 3);
    }

    #[test]
    fn wave_zero_matches_the_tick() {
        // The parity guard: wave 0 IS `eligible_tasks(..).take(free)` — the exact slice
        // `auto_loop::tick` launches. If the projection ever drifts from the launcher,
        // this fails rather than the board quietly lying about "next up".
        let tasks = vec![
            task("done", TaskStatus::Done, 1, &[]),
            task("a", TaskStatus::Ready, 10, &["done"]),
            task("b", TaskStatus::Backlog, 20, &[]),
            task("c", TaskStatus::Ready, 30, &[]),
            task("blocked", TaskStatus::Ready, 5, &["a"]),
            task("running", TaskStatus::InProgress, 2, &[]),
            task("leased", TaskStatus::Ready, 3, &[]),
        ];
        let leased = |id: &str| id == "leased";
        for free in 0..=4usize {
            let expected: Vec<String> = eligible_tasks(&tasks, leased)
                .into_iter()
                .take(free)
                .map(|t| t.id.clone())
                .collect();
            let p = project_run_order(&tasks, leased, free, 3);
            let wave0: Vec<String> = p
                .entries
                .iter()
                .filter(|e| e.wave == 0)
                .map(|e| e.task_id.clone())
                .collect();
            assert_eq!(
                wave0, expected,
                "wave 0 must equal the tick's slice (free={free})"
            );
            assert_eq!(p.starts_now_count as usize, expected.len());
        }
    }

    #[test]
    fn a_chain_lands_in_successive_waves() {
        // The hand-minted chain case the ticket names: three tasks, each depending on
        // the previous. Even with capacity for all three, only the head starts now.
        let tasks = vec![
            task("one", TaskStatus::Backlog, 10, &[]),
            task("two", TaskStatus::Backlog, 20, &["one"]),
            task("three", TaskStatus::Backlog, 30, &["two"]),
        ];
        let p = project_run_order(&tasks, |_| false, 3, 3);
        assert_eq!(ids(&p), vec!["one", "two", "three"]);
        assert_eq!(
            p.entries.iter().map(|e| e.wave).collect::<Vec<_>>(),
            vec![0, 1, 2],
            "each link waits a wave for its predecessor"
        );
        assert_eq!(p.starts_now_count, 1, "only the chain head starts now");
        assert_eq!(p.entries[1].blocked_by, vec!["one".to_string()]);
        assert!(p.entries[0].blocked_by.is_empty());
    }

    #[test]
    fn free_slots_cap_wave_zero_and_the_rest_spill_forward() {
        let tasks = vec![
            task("a", TaskStatus::Ready, 10, &[]),
            task("b", TaskStatus::Ready, 20, &[]),
            task("c", TaskStatus::Ready, 30, &[]),
        ];
        let p = project_run_order(&tasks, |_| false, 1, 2);
        assert_eq!(ids(&p), vec!["a", "b", "c"]);
        assert_eq!(
            p.entries.iter().map(|e| e.wave).collect::<Vec<_>>(),
            vec![0, 1, 1],
            "one free slot now, then the full concurrency per wave"
        );
        assert_eq!(p.starts_now_count, 1);
        assert_eq!(p.free_slots, 1);
        assert_eq!(p.max_concurrency, 2);
    }

    #[test]
    fn no_free_slots_still_projects_the_order_with_nothing_starting_now() {
        // Every slot busy: arming starts nothing, but the queue order is still legible
        // (the whole point — the user can see what is next without guessing).
        let tasks = vec![
            task("running", TaskStatus::InProgress, 1, &[]),
            task("a", TaskStatus::Ready, 10, &[]),
            task("b", TaskStatus::Ready, 20, &[]),
        ];
        let p = project_run_order(&tasks, |id| id == "running", 0, 1);
        assert_eq!(p.starts_now_count, 0, "no free slot ⇒ nothing starts now");
        assert_eq!(ids(&p), vec!["a", "b"]);
        assert!(p.entries.iter().all(|e| !e.starts_now));
        assert!(p.unreachable.is_empty());
    }

    #[test]
    fn a_dependent_of_an_in_flight_run_is_ordered_not_unreachable() {
        // `running` is neither Done nor launchable, so `deps_satisfied` says no today —
        // but it WILL finish, so its dependent belongs in the order (wave 1), not in
        // the unreachable bucket.
        let tasks = vec![
            task("running", TaskStatus::InProgress, 1, &[]),
            task("after", TaskStatus::Backlog, 10, &["running"]),
        ];
        let p = project_run_order(&tasks, |id| id == "running", 2, 3);
        assert_eq!(ids(&p), vec!["after"]);
        assert_eq!(p.entries[0].wave, 1);
        assert!(!p.entries[0].starts_now);
        assert_eq!(
            p.entries[0].blocked_by,
            vec!["running".to_string()],
            "the live blocker is still named"
        );
        assert!(p.unreachable.is_empty());
    }

    #[test]
    fn a_missing_or_failed_dependency_is_unreachable_never_ordered() {
        let tasks = vec![
            task("failed-dep", TaskStatus::Failed, 1, &[]),
            task("ghost-dep", TaskStatus::Ready, 10, &["nope"]),
            task("after-failed", TaskStatus::Ready, 20, &["failed-dep"]),
            task("fine", TaskStatus::Ready, 30, &[]),
        ];
        let p = project_run_order(&tasks, |_| false, 3, 3);
        assert_eq!(ids(&p), vec!["fine"], "only the runnable task is ordered");
        let mut unreachable = p.unreachable.clone();
        unreachable.sort();
        assert_eq!(unreachable, vec!["after-failed", "ghost-dep"]);
    }

    #[test]
    fn a_dependency_cycle_is_unreachable_and_terminates() {
        let tasks = vec![
            task("a", TaskStatus::Backlog, 10, &["b"]),
            task("b", TaskStatus::Backlog, 20, &["a"]),
        ];
        let p = project_run_order(&tasks, |_| false, 3, 3);
        assert!(p.entries.is_empty(), "a cycle never becomes eligible");
        let mut unreachable = p.unreachable.clone();
        unreachable.sort();
        assert_eq!(unreachable, vec!["a", "b"]);
    }

    #[test]
    fn an_empty_board_projects_nothing() {
        let tasks: Vec<Task> = Vec::new();
        let p = project_run_order(&tasks, |_| false, 3, 3);
        assert!(p.entries.is_empty() && p.unreachable.is_empty());
        assert_eq!(p.starts_now_count, 0);
    }

    #[test]
    fn projection_serializes_camel_case() {
        // The wire contract with the webview (and the ts-rs bindings) is camelCase.
        let tasks = vec![task("a", TaskStatus::Ready, 10, &["nope"])];
        let p = project_run_order(&tasks, |_| false, 1, 1);
        let value = serde_json::to_value(&p).expect("serialize");
        let obj = value.as_object().expect("object");
        for key in [
            "entries",
            "unreachable",
            "freeSlots",
            "maxConcurrency",
            "startsNowCount",
        ] {
            assert!(obj.contains_key(key), "missing camelCase key {key}");
        }

        let with_entry =
            project_run_order(&[task("solo", TaskStatus::Ready, 1, &[])], |_| false, 1, 1);
        let entry = &serde_json::to_value(&with_entry).unwrap()["entries"][0];
        for key in ["taskId", "position", "wave", "startsNow", "blockedBy"] {
            assert!(
                entry.as_object().unwrap().contains_key(key),
                "missing camelCase entry key {key}"
            );
        }
    }
}
