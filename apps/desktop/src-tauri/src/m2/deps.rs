//! Dependency ordering (M2 Tier-1, §5 of the design doc).
//!
//! A task is eligible to run only when every id in its `dependencies` names a
//! task that is `Done`. This is a pure function — no I/O, no Tauri — so it ships
//! fully implemented and unit-tested now as the cheapest Tier-1 port. The
//! auto-loop coordinator (not yet scaffolded) will call this per tick to filter
//! the eligible set; ordered execution falls out naturally as deps complete.

use std::collections::HashMap;

use crate::task::{Task, TaskStatus};

/// True when all of `task`'s dependencies exist and are `Done`.
///
/// Fails **closed**: a dependency id with no matching task (e.g. the dep was
/// deleted) counts as unsatisfied, so the loop never runs a task whose
/// prerequisite has vanished. A dependency cycle simply never becomes eligible —
/// the single-pass status check can't deadlock or spin.
pub fn deps_satisfied(task: &Task, by_id: &HashMap<String, &Task>) -> bool {
    task.dependencies
        .iter()
        .all(|dep| matches!(by_id.get(dep).map(|t| t.status), Some(TaskStatus::Done)))
}

/// Index a task slice by id for repeated [`deps_satisfied`] lookups.
pub fn index_by_id(tasks: &[Task]) -> HashMap<String, &Task> {
    tasks.iter().map(|t| (t.id.clone(), t)).collect()
}

/// Whether a task is in a launchable status. The auto-loop pulls `Ready` and
/// `Backlog` tasks (the design's auto-promote choice — §2 step 3); everything else
/// (in-progress, waiting-approval, terminal) is skipped.
pub fn is_launchable_status(status: TaskStatus) -> bool {
    matches!(status, TaskStatus::Ready | TaskStatus::Backlog)
}

/// The set of tasks the coordinator may launch this tick: a launchable status,
/// dependencies all `Done`, and not already holding a slot (`is_leased`). The
/// result is sorted by `created_at` (then `id`) for deterministic, reproducible
/// run order. Pure — `is_leased` is injected so this stays unit-testable without a
/// live `SlotManager`.
pub fn eligible_tasks<F>(tasks: &[Task], is_leased: F) -> Vec<&Task>
where
    F: Fn(&str) -> bool,
{
    let index = index_by_id(tasks);
    let mut eligible: Vec<&Task> = tasks
        .iter()
        .filter(|t| is_launchable_status(t.status))
        .filter(|t| !is_leased(&t.id))
        .filter(|t| deps_satisfied(t, &index))
        .collect();
    eligible.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    eligible
}

/// Whether a task is `blocked` — launchable in status but with an unsatisfied
/// dependency (so the UI can surface "waiting on deps" vs. "idle"). A vanished or
/// failed dependency reads as blocked (fail-closed), matching [`deps_satisfied`].
///
/// Backend-ready for the frontend wiring step (the `blocked` badge); not yet called
/// from a command, hence allowed-dead until the UI consumes it.
#[allow(dead_code)]
pub fn is_blocked(task: &Task, by_id: &HashMap<String, &Task>) -> bool {
    is_launchable_status(task.status) && !deps_satisfied(task, by_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task_with(id: &str, status: TaskStatus, deps: &[&str]) -> Task {
        let mut t = Task::new(id.to_string(), String::new());
        t.id = id.to_string();
        t.status = status;
        t.dependencies = deps.iter().map(|s| s.to_string()).collect();
        t
    }

    #[test]
    fn no_dependencies_is_always_satisfied() {
        let task = task_with("a", TaskStatus::Ready, &[]);
        let index = index_by_id(std::slice::from_ref(&task));
        assert!(deps_satisfied(&task, &index));
    }

    #[test]
    fn satisfied_when_all_deps_done() {
        let dep1 = task_with("d1", TaskStatus::Done, &[]);
        let dep2 = task_with("d2", TaskStatus::Done, &[]);
        let task = task_with("a", TaskStatus::Ready, &["d1", "d2"]);
        let all = vec![dep1, dep2, task.clone()];
        let index = index_by_id(&all);
        assert!(deps_satisfied(&task, &index));
    }

    #[test]
    fn unsatisfied_when_a_dep_is_not_done() {
        let dep_done = task_with("d1", TaskStatus::Done, &[]);
        let dep_running = task_with("d2", TaskStatus::InProgress, &[]);
        let task = task_with("a", TaskStatus::Ready, &["d1", "d2"]);
        let all = vec![dep_done, dep_running, task.clone()];
        let index = index_by_id(&all);
        assert!(!deps_satisfied(&task, &index));
    }

    #[test]
    fn fails_closed_on_missing_dependency() {
        // The dependency id names no existing task (e.g. it was deleted).
        let task = task_with("a", TaskStatus::Ready, &["ghost"]);
        let index = index_by_id(std::slice::from_ref(&task));
        assert!(
            !deps_satisfied(&task, &index),
            "a vanished dependency must read as unsatisfied"
        );
    }

    #[test]
    fn a_failed_dependency_is_not_satisfied() {
        let dep = task_with("d1", TaskStatus::Failed, &[]);
        let task = task_with("a", TaskStatus::Ready, &["d1"]);
        let all = vec![dep, task.clone()];
        let index = index_by_id(&all);
        assert!(!deps_satisfied(&task, &index));
    }

    #[test]
    fn launchable_statuses_are_ready_and_backlog() {
        assert!(is_launchable_status(TaskStatus::Ready));
        assert!(is_launchable_status(TaskStatus::Backlog));
        for s in [
            TaskStatus::InProgress,
            TaskStatus::WaitingApproval,
            TaskStatus::Done,
            TaskStatus::Failed,
        ] {
            assert!(!is_launchable_status(s), "{s:?} is not launchable");
        }
    }

    #[test]
    fn eligible_skips_running_terminal_blocked_and_leased() {
        let done_dep = task_with("dep", TaskStatus::Done, &[]);
        let ready = task_with("ready", TaskStatus::Ready, &["dep"]); // deps ok → eligible
        let backlog = task_with("backlog", TaskStatus::Backlog, &[]); // eligible
        let running = task_with("running", TaskStatus::InProgress, &[]); // wrong status
        let blocked = task_with("blocked", TaskStatus::Ready, &["missing"]); // dep unmet
        let leased = task_with("leased", TaskStatus::Ready, &[]); // holds a slot

        let all = vec![
            done_dep,
            ready.clone(),
            backlog.clone(),
            running,
            blocked,
            leased,
        ];
        let eligible = eligible_tasks(&all, |id| id == "leased");
        let ids: Vec<&str> = eligible.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"ready"));
        assert!(ids.contains(&"backlog"));
        assert!(!ids.contains(&"running"), "in-progress is skipped");
        assert!(!ids.contains(&"blocked"), "unmet deps are skipped");
        assert!(!ids.contains(&"leased"), "already-leased is skipped");
    }

    #[test]
    fn eligible_is_ordered_by_created_at_then_id() {
        let mut older = task_with("z-older", TaskStatus::Ready, &[]);
        older.created_at = 100;
        let mut newer = task_with("a-newer", TaskStatus::Ready, &[]);
        newer.created_at = 200;
        let mut tie_a = task_with("a-tie", TaskStatus::Ready, &[]);
        tie_a.created_at = 100;

        let all = vec![newer, older, tie_a];
        let eligible = eligible_tasks(&all, |_| false);
        let ids: Vec<&str> = eligible.iter().map(|t| t.id.as_str()).collect();
        // created_at 100 first (id-tie broken alphabetically: a-tie < z-older),
        // then created_at 200.
        assert_eq!(ids, vec!["a-tie", "z-older", "a-newer"]);
    }

    #[test]
    fn blocked_reflects_unmet_dependencies() {
        let blocked = task_with("a", TaskStatus::Ready, &["ghost"]);
        let index = index_by_id(std::slice::from_ref(&blocked));
        assert!(is_blocked(&blocked, &index), "ready with a missing dep is blocked");

        let idle = task_with("b", TaskStatus::Ready, &[]);
        let index = index_by_id(std::slice::from_ref(&idle));
        assert!(!is_blocked(&idle, &index), "ready with no deps is not blocked");

        // A terminal task is never 'blocked' regardless of deps.
        let done = task_with("c", TaskStatus::Done, &["ghost"]);
        let index = index_by_id(std::slice::from_ref(&done));
        assert!(!is_blocked(&done, &index), "done is not a blocked state");
    }
}
