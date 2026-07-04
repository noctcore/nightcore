//! The concurrency substrate shared across the terminal task actions
//! (commit / merge / finalize / PR-create) and the pull-base fast-forward: the
//! per-task single-flight sets, the RAII [`TaskLease`], and the project-root
//! mutation lease. Shared with the PR arc (`pr.rs`, `pr_status.rs`,
//! `pr_comments.rs`) through the `crate::workflow::merge` facade.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

/// Per-task single-flight guards for the long, blocking workflow commands. A
/// synchronous `#[tauri::command]` runs on the main thread and so was implicitly
/// serialized with itself; moving these bodies to the blocking pool (so they don't
/// freeze the UI) removed that. Without a lock a double-fire would run the whole body
/// twice for one task — two `claude -p` generations + two `git commit`s for commit
/// (the second hitting an empty index), or two gauntlet+merge passes for merge. Each
/// guard restores single-flight per task at the backend, independent of (and defence-
/// in-depth behind) the frontend pending guard.
pub(crate) fn commit_in_flight() -> &'static Mutex<HashSet<String>> {
    static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(crate) fn merge_in_flight() -> &'static Mutex<HashSet<String>> {
    static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Whether an in-flight set currently holds `id` — the cross-action probe the
/// terminal actions use to refuse their SIBLINGS (a merge refuses while a PR
/// creation holds the task and vice versa), since the per-action `TaskLease`
/// only serializes an action with itself.
pub(crate) fn lease_held(set: &'static Mutex<HashSet<String>>, id: &str) -> bool {
    set.lock().unwrap_or_else(|e| e.into_inner()).contains(id)
}

/// RAII membership in one of the in-flight sets: inserts on acquire, removes on drop —
/// so an early `?` return (or a panic) still releases the task. `acquire` yields `None`
/// when that action is already running for `id`, so the caller can refuse rather than race.
/// Shared with the sibling workflow commands (`pr.rs` brings its own action set).
pub(crate) struct TaskLease {
    id: String,
    set: &'static Mutex<HashSet<String>>,
}

impl TaskLease {
    pub(crate) fn acquire(set: &'static Mutex<HashSet<String>>, id: &str) -> Option<Self> {
        let mut guard = set.lock().unwrap_or_else(|e| e.into_inner());
        guard.insert(id.to_string()).then(|| Self {
            id: id.to_string(),
            set,
        })
    }
}

impl Drop for TaskLease {
    fn drop(&mut self) {
        self.set
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

/// The PROJECT-ROOT mutation guard, keyed per project path (the `TaskLease`
/// machinery reused with a path key). The per-task leases serialize actions on
/// one TASK, but three actions mutate the SHARED project root working tree —
/// the pull-base fast-forward (fetch + ff-merge), `merge_task`'s real merge,
/// and a main-mode commit's stage/commit — and nothing serialized them against
/// each other: concurrent tasks could collide on the root index (`index.lock`)
/// or fast-forward/merge a root that just moved under a confirmed-safe dialog.
///
/// LOCK ORDERING (deadlock freedom): every path acquires its per-task action
/// lease FIRST and this root lease SECOND, and no path ever acquires a task
/// lease while holding the root lease. Both levels are TRY-acquire — a held
/// lease refuses with a message, never waits — so there is no blocking cycle
/// at all; the ordering rule exists so the refusal messages stay causal.
fn root_mutation_in_flight() -> &'static Mutex<HashSet<String>> {
    static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Acquire the root-mutation lease for `project_path`, or refuse naming the
/// blocked action (`before_what` completes "wait for it to finish before …").
/// Shared with the pull-base command (`pr_status.rs`).
pub(crate) fn acquire_root_lease(
    project_path: &std::path::Path,
    before_what: &str,
) -> Result<TaskLease, String> {
    TaskLease::acquire(root_mutation_in_flight(), &project_path.to_string_lossy())
        .ok_or_else(|| {
            format!(
            "another action is modifying the project root — wait for it to finish before {before_what}"
        )
        })
}
