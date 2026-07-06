//! The in-memory task registry (`TaskStore`) and its disk-load helpers.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::task::Task;

use super::{is_safe_task_id, workspace_root, write_atomic};

/// Load every `*.json` task file under `dir` into a map keyed by id, creating the
/// directory if missing. Unparsable files are skipped with a log rather than
/// aborting. Shared by [`TaskStore::load_from`] and [`TaskStore::retarget`].
fn read_dir_into_map(dir: &PathBuf) -> HashMap<String, Arc<Task>> {
    if let Err(e) = std::fs::create_dir_all(dir) {
        tracing::warn!(target: "nightcore::store", dir = %dir.display(), error = %e, "failed to create tasks dir");
    }

    let mut tasks = HashMap::new();
    match std::fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                match std::fs::read_to_string(&path) {
                    Ok(raw) => match serde_json::from_str::<Task>(&raw) {
                        Ok(task) => {
                            tasks.insert(task.id.clone(), Arc::new(task));
                        }
                        Err(e) => {
                            tracing::warn!(target: "nightcore::store", path = %path.display(), error = %e, "skipping unparsable task file")
                        }
                    },
                    Err(e) => {
                        tracing::warn!(target: "nightcore::store", path = %path.display(), error = %e, "cannot read task file")
                    }
                }
            }
        }
        Err(e) => {
            tracing::warn!(target: "nightcore::store", dir = %dir.display(), error = %e, "cannot list tasks dir")
        }
    }
    tasks
}

/// The highest [`Task::seq`] across a loaded task map (0 for an empty map or a
/// map of all-legacy tasks). The store seeds its seq counter from this so a load
/// or project-switch re-target keeps `seq` strictly increasing above whatever is
/// already persisted, instead of restarting at 0 and letting a reloaded task
/// out-rank a freshly-stamped one.
fn seq_high_water(tasks: &HashMap<String, Arc<Task>>) -> u64 {
    tasks.values().map(|t| t.seq).max().unwrap_or(0)
}

/// In-memory task map plus the directory it persists to.
///
/// The target dir is interior-mutable: Phase 2 makes tasks **project-scoped**, so
/// activating a project [`retarget`](TaskStore::retarget)s the store at that
/// project's `.nightcore/tasks/` and reloads. With no active project the store is
/// targeted at an empty dir and the board is empty.
pub struct TaskStore {
    /// The in-memory board, keyed by id. Values are `Arc<Task>` so a read snapshot
    /// (`list`) clones one pointer per task instead of the whole struct — the
    /// auto-loop tick and the `reconcile_*` reconcilers snapshot the entire board
    /// every 750ms, and a deep clone per `Task` (Vec deps/attachments/subtasks, the
    /// `StructureLockResult`, and the plan/review/error/summary strings) generated
    /// O(tasks × task-size) garbage per tick regardless of activity. A write does a
    /// single copy-on-write clone of the one task it mutates before re-`Arc`-ing it.
    tasks: Mutex<HashMap<String, Arc<Task>>>,
    dir: Mutex<PathBuf>,
    /// Per-task write-serialization locks, keyed by task id.
    ///
    /// The read-modify-write-persist of one task must be serialized against
    /// *other writes to the same task* (the C7 anti-clobber invariant), but that
    /// serialization must NOT be shared with reads or writes of a *different* task.
    /// The disk write (`write_file` → `sync_data`, an fdatasync — single-digit to
    /// tens of ms on a busy disk) used to run while the single global `tasks` lock
    /// was held, so a slow write for one streaming task stalled `list()`/`get()`
    /// and every other task's `mutate` behind it (head-of-line blocking under
    /// `max_concurrency` up to 6). Splitting the write lock out per id keeps the
    /// `tasks` map lock for the O(1) read-clone + insert only — never across the
    /// fsync — while a task's persist is still serialized against concurrent
    /// writers to that same id via its own [`Arc<Mutex<()>>`]. Different tasks hold
    /// different locks, so they fsync in parallel.
    write_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Monotonic source for the per-snapshot [`Task::seq`]. Bumped on every
    /// persist (`upsert`/`mutate_if`) so each emitted `nc:task` carries a strictly
    /// greater `seq` than the prior one — the web orders snapshots by it instead of
    /// the collision-prone millisecond `updated_at`. Seeded above the highest `seq`
    /// already on disk (per [`seq_high_water`]) so reloaded tasks never out-rank a
    /// freshly-stamped one after a load/retarget.
    seq: AtomicU64,
}

impl TaskStore {
    /// Load every task file under `<workspace_root>/.nightcore/tasks/` into memory.
    /// Creates the directory if missing. Unparsable files are skipped with a log
    /// rather than aborting startup.
    pub fn load() -> Self {
        Self::load_from(workspace_root().join(".nightcore/tasks"))
    }

    /// Load every task file under `dir` into memory, creating the directory if
    /// missing. Factored out of [`load`](Self::load) so tests can point the store
    /// at a temp dir instead of the real workspace.
    pub fn load_from(dir: PathBuf) -> Self {
        let tasks = read_dir_into_map(&dir);
        let seq = AtomicU64::new(seq_high_water(&tasks));
        Self {
            tasks: Mutex::new(tasks),
            dir: Mutex::new(dir),
            write_locks: Mutex::new(HashMap::new()),
            seq,
        }
    }

    /// Re-point the store at `dir`, clearing the in-memory map and reloading from
    /// the new directory. Called when a project is activated (or deactivated, with
    /// no project, an empty scratch dir) so the board reflects the active project's
    /// tasks. Existing files on disk are untouched.
    pub fn retarget(&self, dir: PathBuf) {
        let reloaded = read_dir_into_map(&dir);
        // Reseed the seq counter above the new dir's high-water mark so a project
        // switch keeps `seq` strictly increasing for every subsequent persist.
        self.seq.store(seq_high_water(&reloaded), Ordering::Relaxed);
        *crate::sync::lock_or_recover(&self.tasks) = reloaded;
        *crate::sync::lock_or_recover(&self.dir) = dir;
        // Drop the old project's per-task write locks — the new project's tasks get
        // fresh locks on first write. This bounds the registry to the tasks seen in
        // one project session rather than accumulating across every switch. An
        // in-flight writer still holds its own `Arc`, so clearing the map only drops
        // this store's reference, never a live lock.
        crate::sync::lock_or_recover(&self.write_locks).clear();
    }

    /// The next monotonic [`Task::seq`] value. A pre-increment so the first stamp is
    /// `1` (a stamped task is always `> 0`, distinguishing it from never-persisted
    /// or legacy `0`).
    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// The write-serialization lock for `id`, created on first use. A caller locks
    /// the returned `Arc<Mutex<()>>` for the whole read-modify-write-persist so two
    /// writers to the *same* id can't interleave and clobber each other (C7), while
    /// writers to *different* ids proceed in parallel. The registry mutex is held
    /// only long enough to look up / insert the `Arc` — never across the write — so
    /// obtaining a lock for task A never waits on task B's in-flight fsync.
    fn write_lock_for(&self, id: &str) -> Arc<Mutex<()>> {
        crate::sync::lock_or_recover(&self.write_locks)
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Path to a task's JSON file under the current target dir. Rejects an id that
    /// is not a safe flat filename component (path-traversal defence in depth) so a
    /// crafted id can never join outside the tasks dir.
    fn path_for(&self, id: &str) -> Result<PathBuf, String> {
        if !is_safe_task_id(id) {
            return Err(format!("invalid task id: {id}"));
        }
        Ok(crate::sync::lock_or_recover(&self.dir).join(format!("{id}.json")))
    }

    /// The current tasks directory (the active project's `.nightcore/tasks/`). Used
    /// by the transcript store (M4.7 §C) to locate a task's `<id>/transcript.jsonl`
    /// alongside its `<id>.json`.
    pub fn tasks_dir(&self) -> PathBuf {
        crate::sync::lock_or_recover(&self.dir).clone()
    }

    /// Snapshot of all tasks (unordered).
    ///
    /// Returns `Arc<Task>` so a full-board snapshot is O(tasks) pointer clones, not a
    /// deep clone of every `Task`. This is the hot read: the coordinator tick and the
    /// `reconcile_*`/`blocked_task_ids` scans call it on a 750ms interval. The pure
    /// dependency helpers (`eligible_tasks`/`index_by_id`) are generic over
    /// `Borrow<Task>`, so the returned `Vec<Arc<Task>>` feeds them without a re-clone.
    pub fn list(&self) -> Vec<Arc<Task>> {
        crate::sync::lock_or_recover(&self.tasks)
            .values()
            .cloned()
            .collect()
    }

    /// A single task by id, if present. Clones the one task (O(1) in the board size),
    /// so callers keep an owned `Task`; the full-board hot path is [`list`](Self::list).
    pub fn get(&self, id: &str) -> Option<Task> {
        crate::sync::lock_or_recover(&self.tasks)
            .get(id)
            .map(|t| t.as_ref().clone())
    }

    /// Insert or replace a task and write its file, stamping a fresh monotonic
    /// [`Task::seq`]; returns the stamped task so the caller emits the snapshot
    /// that's actually on disk. Bumping `updated_at` is the caller's responsibility
    /// (see [`mutate`](Self::mutate)).
    ///
    /// Serializes against a concurrent `mutate`/`upsert`/`remove` on the *same* id
    /// via that id's [write lock](Self::write_lock_for) — NOT the global `tasks`
    /// mutex — so the same-id read-modify-write can't interleave (C7 / concurrency
    /// #2) while a *different* task's write (or a `list()`/`get()`) never blocks on
    /// this one's fsync. The in-memory map is only updated after the disk write
    /// succeeds, so a failed persist leaves the prior record authoritative in memory
    /// rather than diverging from disk.
    pub fn upsert(&self, task: &Task) -> Result<Task, String> {
        // Reject an unsafe id before touching the lock registry so a crafted id
        // neither creates a write-lock entry nor reaches the filesystem join.
        if !is_safe_task_id(&task.id) {
            return Err(format!("invalid task id: {}", task.id));
        }
        // Serialize this write against concurrent writers to THIS id only.
        let wlock = self.write_lock_for(&task.id);
        let _write = crate::sync::lock_or_recover(&wlock);

        // Stamp a fresh monotonic seq on the persisted+stored snapshot so this write
        // (and the `nc:task` the caller emits from the returned value) orders after
        // every prior one. The caller MUST emit the returned task, not its input, so
        // the snapshot on the wire carries the assigned `seq`.
        let mut stamped = task.clone();
        stamped.seq = self.next_seq();
        // The fsync runs holding only this id's write lock; the `tasks` map lock is
        // NOT held, so a concurrent read or a different task's write never waits.
        self.write_file(&stamped)?;
        // Publish to memory only after the disk write succeeds — the map lock is held
        // for this O(1) insert alone. Stored behind an `Arc` so reads snapshot a
        // pointer; the returned owned `Task` is the caller's to emit.
        crate::sync::lock_or_recover(&self.tasks)
            .insert(stamped.id.clone(), Arc::new(stamped.clone()));
        Ok(stamped)
    }

    /// Apply `f` to the current task, bump `updated_at`, then persist and store it
    /// atomically. Returns the updated task. Errors if the id is unknown.
    ///
    /// The whole read-modify-write is serialized on that id's
    /// [write lock](Self::write_lock_for) (C7): the read-clone, the mutation, the
    /// disk write, and the in-memory replace can't interleave with another writer to
    /// the *same* id, so the sidecar reader and a Tauri handler can no longer each
    /// persist a full record and clobber the other's fields. A write to a *different*
    /// task holds a different lock and proceeds in parallel.
    pub fn mutate<F>(&self, id: &str, f: F) -> Result<Task, String>
    where
        F: FnOnce(&mut Task),
    {
        self.mutate_if(id, |_| Ok(()), f)
    }

    /// Like [`mutate`](Self::mutate) but gated on a precondition: `check` is run
    /// against the current task while this id's [write lock](Self::write_lock_for) is
    /// held, and an `Err` short-circuits without mutating. This folds the common
    /// check-then-act pattern (read status, decide, write) under ONE per-id write
    /// lock (concurrency #2) so a status check and the write it guards can't race a
    /// concurrent transition of the *same* task between them.
    pub fn mutate_if<C, F>(&self, id: &str, check: C, f: F) -> Result<Task, String>
    where
        C: FnOnce(&Task) -> Result<(), String>,
        F: FnOnce(&mut Task),
    {
        // Hold this id's write lock across the whole read-modify-write-persist. The
        // global `tasks` map lock is taken only twice, briefly: once for the O(1)
        // read-clone and once for the O(1) insert — never across the fsync — so a
        // different task's `mutate` or a `list()`/`get()` never blocks on this
        // write. Same-id writers serialize on this lock, so the read below always
        // observes the previous same-id write's insert (no lost update).
        let wlock = self.write_lock_for(id);
        let _write = crate::sync::lock_or_recover(&wlock);

        let mut task = crate::sync::lock_or_recover(&self.tasks)
            .get(id)
            .map(|t| t.as_ref().clone())
            .ok_or_else(|| format!("no task with id {id}"))?;
        check(&task)?;
        f(&mut task);
        task.updated_at = crate::task::now_ms();
        // Stamp the monotonic seq alongside `updated_at` so the returned snapshot
        // (which the caller emits as `nc:task`) orders strictly after the prior one.
        task.seq = self.next_seq();
        // Persist (fsync) holding only the per-id write lock; the map lock is not held.
        self.write_file(&task)?;
        // Publish to memory after the write succeeds — memory never runs ahead of disk.
        // Re-`Arc` the mutated task so the map keeps sharing a pointer with readers.
        crate::sync::lock_or_recover(&self.tasks).insert(task.id.clone(), Arc::new(task.clone()));
        Ok(task)
    }

    /// Remove a task from memory and delete its file. Idempotent on a missing file.
    /// Takes this id's [write lock](Self::write_lock_for) across the memory-remove +
    /// disk-delete so it can't interleave with a concurrent `upsert`/`mutate` on the
    /// same id (which would otherwise resurrect the file/record after the delete);
    /// the global `tasks` lock is held only for the O(1) map removal, not across the
    /// unlink, so a slow filesystem doesn't stall other tasks.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        // Validates the id (path-traversal defence) and fails fast before any lock,
        // so an unsafe id never creates a write-lock registry entry.
        let path = self.path_for(id)?;
        // Serialize against same-id writers: once we've removed the record here, a
        // mutate that was blocked on this lock will read a map-miss and error rather
        // than re-persisting a deleted task.
        let wlock = self.write_lock_for(id);
        let _write = crate::sync::lock_or_recover(&wlock);
        crate::sync::lock_or_recover(&self.tasks).remove(id);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("failed to delete {}: {e}", path.display())),
        }
    }

    /// Write one task as compact JSON to its file via a temp-file + atomic `rename`,
    /// so a crash or concurrent reader never sees a half-written task file
    /// (data-integrity #3). The temp file lives in the same dir as the target so the
    /// rename stays on one filesystem (a cross-device rename would fail). Compact
    /// (not pretty) serialization: the file is only ever read back by serde, so the
    /// pretty-printer's indentation work + larger byte count is avoidable overhead on
    /// this per-mutation hot path (many small lifecycle bumps per auto-loop tick).
    fn write_file(&self, task: &Task) -> Result<(), String> {
        let path = self.path_for(&task.id)?;
        let json = serde_json::to_string(task).map_err(|e| e.to_string())?;
        write_atomic(&path, json.as_bytes())
            .map_err(|e| format!("failed to persist task {}: {e}", task.id))
    }
}
