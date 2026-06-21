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
}
