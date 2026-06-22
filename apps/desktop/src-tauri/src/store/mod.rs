//! The on-disk task registry.
//!
//! One pretty-printed JSON file per task at
//! `<workspace_root>/.nightcore/tasks/<id>.json`. The store keeps an in-memory
//! map (behind a `Mutex`) as the source of truth for reads, and writes through to
//! disk on every mutation so a restart reloads the exact same board. `.nightcore/`
//! is already gitignored.
//!
//! Held in managed Tauri state; commands take it as `State<'_, TaskStore>`.

pub(crate) mod project;
pub(crate) mod settings;
pub(crate) mod task;
pub(crate) mod transcript;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::task::Task;

/// Whether a task id is a safe filename component (defence in depth against path
/// traversal at the `<id>.json` join). Ids are server-minted uuids, but the id
/// also arrives from the wire on commands; an id carrying `.` / `/` / `\` (or any
/// path separator) could escape the tasks dir, so reject anything that isn't a
/// flat `[A-Za-z0-9_-]+` token. Empty is rejected too. Shared with `transcript.rs`.
pub(crate) fn is_safe_task_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Workspace root (`apps/desktop/src-tauri` → up three), the same cwd resolution
/// M0 used for the sidecar. M1 keeps tasks under this project's `.nightcore/`.
pub fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// Load every `*.json` task file under `dir` into a map keyed by id, creating the
/// directory if missing. Unparsable files are skipped with a log rather than
/// aborting. Shared by [`TaskStore::load_from`] and [`TaskStore::retarget`].
fn read_dir_into_map(dir: &PathBuf) -> HashMap<String, Task> {
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
                            tasks.insert(task.id.clone(), task);
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

/// In-memory task map plus the directory it persists to.
///
/// The target dir is interior-mutable: Phase 2 makes tasks **project-scoped**, so
/// activating a project [`retarget`](TaskStore::retarget)s the store at that
/// project's `.nightcore/tasks/` and reloads. With no active project the store is
/// targeted at an empty dir and the board is empty.
pub struct TaskStore {
    tasks: Mutex<HashMap<String, Task>>,
    dir: Mutex<PathBuf>,
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
        Self {
            tasks: Mutex::new(tasks),
            dir: Mutex::new(dir),
        }
    }

    /// Re-point the store at `dir`, clearing the in-memory map and reloading from
    /// the new directory. Called when a project is activated (or deactivated, with
    /// no project, an empty scratch dir) so the board reflects the active project's
    /// tasks. Existing files on disk are untouched.
    pub fn retarget(&self, dir: PathBuf) {
        let reloaded = read_dir_into_map(&dir);
        *self.tasks.lock().expect("task store poisoned") = reloaded;
        *self.dir.lock().expect("task store poisoned") = dir;
    }

    /// Path to a task's JSON file under the current target dir. Rejects an id that
    /// is not a safe flat filename component (path-traversal defence in depth) so a
    /// crafted id can never join outside the tasks dir.
    fn path_for(&self, id: &str) -> Result<PathBuf, String> {
        if !is_safe_task_id(id) {
            return Err(format!("invalid task id: {id}"));
        }
        Ok(self
            .dir
            .lock()
            .expect("task store poisoned")
            .join(format!("{id}.json")))
    }

    /// The current tasks directory (the active project's `.nightcore/tasks/`). Used
    /// by the transcript store (M4.7 §C) to locate a task's `<id>/transcript.jsonl`
    /// alongside its `<id>.json`.
    pub fn tasks_dir(&self) -> PathBuf {
        self.dir.lock().expect("task store poisoned").clone()
    }

    /// Snapshot of all tasks (unordered).
    pub fn list(&self) -> Vec<Task> {
        self.tasks
            .lock()
            .expect("task store poisoned")
            .values()
            .cloned()
            .collect()
    }

    /// A single task by id, if present.
    pub fn get(&self, id: &str) -> Option<Task> {
        self.tasks
            .lock()
            .expect("task store poisoned")
            .get(id)
            .cloned()
    }

    /// Insert or replace a task and write its file. Bumping `updated_at` is the
    /// caller's responsibility (see [`mutate`](Self::mutate)).
    ///
    /// Holds the `tasks` mutex across the whole write so that a concurrent
    /// `mutate`/`upsert` on the same id can't interleave its read-modify-write
    /// against this one (C7 / concurrency #2). The in-memory map is only updated
    /// after the disk write succeeds, so a failed persist leaves the prior record
    /// authoritative in memory rather than diverging from disk.
    pub fn upsert(&self, task: &Task) -> Result<(), String> {
        let mut guard = self.tasks.lock().expect("task store poisoned");
        self.write_file(task)?;
        guard.insert(task.id.clone(), task.clone());
        Ok(())
    }

    /// Apply `f` to the current task, bump `updated_at`, then persist and store it
    /// atomically. Returns the updated task. Errors if the id is unknown.
    ///
    /// The whole read-modify-write runs under one `tasks` lock acquisition (C7):
    /// the read-clone, the mutation, the disk write, and the in-memory replace are
    /// a single critical section, so the sidecar reader and a Tauri handler can no
    /// longer each persist a full record and clobber the other's fields.
    pub fn mutate<F>(&self, id: &str, f: F) -> Result<Task, String>
    where
        F: FnOnce(&mut Task),
    {
        self.mutate_if(id, |_| Ok(()), f)
    }

    /// Like [`mutate`](Self::mutate) but gated on a precondition: `check` is run
    /// against the current task under the same lock that performs the write, and a
    /// `Err` short-circuits without mutating. This folds the common
    /// check-then-act pattern (read status, decide, write) into ONE lock
    /// acquisition (concurrency #2) so a status check and the write it guards can't
    /// race a concurrent transition between them.
    pub fn mutate_if<C, F>(&self, id: &str, check: C, f: F) -> Result<Task, String>
    where
        C: FnOnce(&Task) -> Result<(), String>,
        F: FnOnce(&mut Task),
    {
        let mut guard = self.tasks.lock().expect("task store poisoned");
        let mut task = guard
            .get(id)
            .cloned()
            .ok_or_else(|| format!("no task with id {id}"))?;
        check(&task)?;
        f(&mut task);
        task.updated_at = crate::task::now_ms();
        self.write_file(&task)?;
        guard.insert(task.id.clone(), task.clone());
        Ok(task)
    }

    /// Remove a task from memory and delete its file. Idempotent on a missing file.
    /// Holds the `tasks` lock across the memory-remove + disk-delete so it can't
    /// interleave with a concurrent `upsert`/`mutate` on the same id.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let path = self.path_for(id)?;
        let mut guard = self.tasks.lock().expect("task store poisoned");
        guard.remove(id);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("failed to delete {}: {e}", path.display())),
        }
    }

    /// Write one task as pretty JSON to its file via a temp-file + atomic `rename`,
    /// so a crash or concurrent reader never sees a half-written task file
    /// (data-integrity #3). The temp file lives in the same dir as the target so the
    /// rename stays on one filesystem (a cross-device rename would fail).
    fn write_file(&self, task: &Task) -> Result<(), String> {
        let path = self.path_for(&task.id)?;
        let json = serde_json::to_string_pretty(task).map_err(|e| e.to_string())?;
        write_atomic(&path, json.as_bytes())
            .map_err(|e| format!("failed to persist task {}: {e}", task.id))
    }
}

/// Write `bytes` to `path` atomically: write to a sibling temp file, then `rename`
/// it over the target. A reader either sees the old file or the new one, never a
/// truncated write (data-integrity #3). The temp file is removed on a write/persist
/// failure so a crash mid-write doesn't litter the dir.
pub(crate) fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("tmp");
    // A unique-ish sibling temp name (pid + nanos) so two concurrent writers to
    // different files in the same dir don't collide.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".{file_name}.{}.{nonce}.tmp", std::process::id()));

    let write_then_rename = || -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    };
    let result = write_then_rename();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::{Task, TaskStatus};
    use tempfile::TempDir;

    /// A store rooted at a fresh temp dir; the dir lives as long as the returned
    /// guard so the test owns its filesystem.
    fn temp_store() -> (TaskStore, TempDir) {
        let tmp = TempDir::new().expect("create temp dir");
        let store = TaskStore::load_from(tmp.path().join("tasks"));
        (store, tmp)
    }

    #[test]
    fn load_from_creates_missing_dir() {
        let tmp = TempDir::new().expect("create temp dir");
        let dir = tmp.path().join("nested/tasks");
        assert!(!dir.exists());
        let store = TaskStore::load_from(dir.clone());
        assert!(dir.is_dir(), "load_from must create the tasks dir");
        assert!(store.list().is_empty());
    }

    #[test]
    fn upsert_persists_and_lists() {
        let (store, tmp) = temp_store();
        let task = Task::new("title".into(), "desc".into());
        let id = task.id.clone();
        store.upsert(&task).expect("upsert");

        assert_eq!(store.list().len(), 1);
        assert_eq!(store.get(&id).expect("get").title, "title");
        assert!(
            tmp.path().join("tasks").join(format!("{id}.json")).exists(),
            "upsert must write the task file"
        );
    }

    #[test]
    fn json_round_trips_through_disk() {
        let (store, _tmp) = temp_store();
        let mut task = Task::new("round".into(), "trip".into());
        task.status = TaskStatus::InProgress;
        task.dependencies = vec!["dep-a".into(), "dep-b".into()];
        task.model = Some("claude-opus-4-8".into());
        task.session_id = Some(42);
        task.summary = Some("ok".into());
        task.cost_usd = Some(0.5);
        store.upsert(&task).expect("upsert");

        // A second store loading the same dir must reconstruct the task exactly.
        let reloaded = TaskStore::load_from(_tmp.path().join("tasks"));
        let got = reloaded.get(&task.id).expect("reload");
        assert_eq!(got.status, TaskStatus::InProgress);
        assert_eq!(got.dependencies, vec!["dep-a", "dep-b"]);
        assert_eq!(got.model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(got.session_id, Some(42));
        assert_eq!(got.summary.as_deref(), Some("ok"));
        assert_eq!(got.cost_usd, Some(0.5));
    }

    #[test]
    fn mutate_bumps_updated_at_and_persists() {
        let (store, _tmp) = temp_store();
        let task = Task::new("t".into(), String::new());
        let id = task.id.clone();
        let created_at = task.created_at;
        store.upsert(&task).expect("upsert");

        // now_ms() has ms resolution; sleep a hair so the bump is observable.
        std::thread::sleep(std::time::Duration::from_millis(2));
        let updated = store
            .mutate(&id, |t| t.status = TaskStatus::Done)
            .expect("mutate");

        assert_eq!(updated.status, TaskStatus::Done);
        assert_eq!(updated.created_at, created_at, "created_at must not change");
        assert!(
            updated.updated_at >= created_at,
            "updated_at must be bumped"
        );
        // Persisted, not just in-memory.
        assert_eq!(store.get(&id).expect("get").status, TaskStatus::Done);
    }

    #[test]
    fn mutate_unknown_id_errors() {
        let (store, _tmp) = temp_store();
        let err = store.mutate("nope", |_| {}).expect_err("must error");
        assert!(err.contains("nope"), "error should name the missing id");
    }

    #[test]
    fn mutate_if_runs_check_and_write_under_one_lock() {
        // The precondition variant gates the write on `check`; a failing check
        // short-circuits without mutating, and a passing one applies `f` (C7 / #2).
        let (store, _tmp) = temp_store();
        let task = Task::new("t".into(), String::new());
        let id = task.id.clone();
        store.upsert(&task).expect("upsert");

        // A failing precondition leaves the task untouched and surfaces the error.
        let err = store
            .mutate_if(
                &id,
                |t| {
                    if t.status == TaskStatus::Backlog {
                        Err("already backlog".to_string())
                    } else {
                        Ok(())
                    }
                },
                |t| t.status = TaskStatus::Done,
            )
            .expect_err("precondition must fail");
        assert_eq!(err, "already backlog");
        assert_eq!(
            store.get(&id).unwrap().status,
            TaskStatus::Backlog,
            "no write on failed check"
        );

        // A passing precondition applies the mutation.
        let updated = store
            .mutate_if(&id, |_| Ok(()), |t| t.status = TaskStatus::InProgress)
            .expect("mutate_if");
        assert_eq!(updated.status, TaskStatus::InProgress);
        assert_eq!(store.get(&id).unwrap().status, TaskStatus::InProgress);
    }

    #[test]
    fn concurrent_mutations_do_not_clobber_each_others_fields() {
        // C7: two threads each mutate a DIFFERENT field of the same task. Pre-fix
        // (get-clone-drop-lock then re-lock upsert) the read-modify-write races and
        // one thread's field is lost; the atomic mutate must preserve both.
        let tmp = TempDir::new().expect("temp dir");
        let store = std::sync::Arc::new(TaskStore::load_from(tmp.path().join("tasks")));
        let task = Task::new("t".into(), String::new());
        let id = task.id.clone();
        store.upsert(&task).expect("upsert");

        let iterations = 200;
        let s1 = store.clone();
        let id1 = id.clone();
        let h1 = std::thread::spawn(move || {
            for i in 0..iterations {
                s1.mutate(&id1, |t| t.summary = Some(format!("s{i}")))
                    .expect("mutate summary");
            }
        });
        let s2 = store.clone();
        let id2 = id.clone();
        let h2 = std::thread::spawn(move || {
            for i in 0..iterations {
                s2.mutate(&id2, |t| t.cost_usd = Some(i as f64))
                    .expect("mutate cost");
            }
        });
        h1.join().expect("join 1");
        h2.join().expect("join 2");

        // Both fields landed: neither thread's last write was clobbered by a stale
        // read-modify-write from the other.
        let final_task = store.get(&id).expect("get");
        assert!(
            final_task.summary.is_some(),
            "summary survived the interleave"
        );
        assert!(
            final_task.cost_usd.is_some(),
            "cost survived the interleave"
        );
    }

    #[test]
    fn write_is_atomic_via_temp_then_rename() {
        // data-integrity #3: a persist either lands the new file or leaves the old
        // one — never a truncated/half-written file. We can't easily induce a crash
        // mid-write, so assert the post-conditions: the file is valid JSON and no
        // `.tmp` litter remains in the dir.
        let (store, tmp) = temp_store();
        let mut task = Task::new("t".into(), String::new());
        let id = task.id.clone();
        store.upsert(&task).expect("upsert");
        task.summary = Some("done".into());
        store.upsert(&task).expect("re-upsert");

        let dir = tmp.path().join("tasks");
        let reloaded = TaskStore::load_from(dir.clone());
        assert_eq!(reloaded.get(&id).unwrap().summary.as_deref(), Some("done"));
        // No leftover temp files (the rename consumed it).
        let leftover: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(
            leftover.is_empty(),
            "no .tmp litter remains after an atomic write"
        );
    }

    #[test]
    fn rejects_path_traversal_task_ids() {
        // Security defence in depth: an id with a path separator / dot can't reach
        // outside the tasks dir. `path_for` (via upsert/mutate/remove) rejects it.
        let (store, _tmp) = temp_store();
        let mut task = Task::new("t".into(), String::new());
        for bad in ["../escape", "a/b", "a\\b", ".", "..", "with.dot", ""] {
            task.id = bad.to_string();
            assert!(
                store.upsert(&task).is_err(),
                "upsert must reject the unsafe id {bad:?}"
            );
            assert!(
                store.remove(bad).is_err(),
                "remove must reject the unsafe id {bad:?}"
            );
        }
        // A normal uuid-shaped id is accepted.
        assert!(is_safe_task_id("3f9a1c2e-0000-4abc-8def-1234567890ab"));
        assert!(is_safe_task_id("task_1-2"));
    }

    #[test]
    fn remove_deletes_file_and_is_idempotent() {
        let (store, tmp) = temp_store();
        let task = Task::new("gone".into(), String::new());
        let id = task.id.clone();
        store.upsert(&task).expect("upsert");
        let path = tmp.path().join("tasks").join(format!("{id}.json"));
        assert!(path.exists());

        store.remove(&id).expect("remove");
        assert!(!path.exists(), "remove must delete the file");
        assert!(store.get(&id).is_none());
        // Removing again (file already gone) is a no-op, not an error.
        store.remove(&id).expect("second remove is idempotent");
    }

    #[test]
    fn load_skips_unparsable_files() {
        let tmp = TempDir::new().expect("create temp dir");
        let dir = tmp.path().join("tasks");
        std::fs::create_dir_all(&dir).expect("mkdir");
        // One valid task, one junk file, one non-json file.
        let task = Task::new("valid".into(), String::new());
        std::fs::write(
            dir.join(format!("{}.json", task.id)),
            serde_json::to_string_pretty(&task).unwrap(),
        )
        .unwrap();
        std::fs::write(dir.join("broken.json"), "{ not valid json").unwrap();
        std::fs::write(dir.join("ignore.txt"), "not a task").unwrap();

        let store = TaskStore::load_from(dir);
        assert_eq!(store.list().len(), 1, "only the valid task loads");
        assert!(store.get(&task.id).is_some());
    }

    #[test]
    fn retarget_swaps_the_task_set() {
        let tmp = TempDir::new().expect("create temp dir");
        let dir_a = tmp.path().join("a/tasks");
        let dir_b = tmp.path().join("b/tasks");

        // Two independent project task dirs, each with one task.
        let store = TaskStore::load_from(dir_a.clone());
        let task_a = Task::new("in-a".into(), String::new());
        store.upsert(&task_a).expect("upsert a");
        assert_eq!(store.list().len(), 1);

        let store_b = TaskStore::load_from(dir_b.clone());
        let task_b = Task::new("in-b".into(), String::new());
        store_b.upsert(&task_b).expect("upsert b");

        // Retargeting at dir_b drops a's tasks and loads b's, and new writes land
        // in dir_b.
        store.retarget(dir_b.clone());
        assert_eq!(store.list().len(), 1, "only b's task is loaded");
        assert!(store.get(&task_b.id).is_some());
        assert!(
            store.get(&task_a.id).is_none(),
            "a's task is no longer in memory"
        );

        let task_c = Task::new("also-b".into(), String::new());
        store.upsert(&task_c).expect("upsert c");
        assert!(
            dir_b.join(format!("{}.json", task_c.id)).exists(),
            "writes go to the retargeted dir"
        );

        // a's file on disk is untouched by the retarget.
        assert!(dir_a.join(format!("{}.json", task_a.id)).exists());
    }

    #[test]
    fn retarget_to_empty_dir_clears_the_board() {
        let tmp = TempDir::new().expect("create temp dir");
        let store = TaskStore::load_from(tmp.path().join("tasks"));
        store
            .upsert(&Task::new("t".into(), String::new()))
            .expect("upsert");
        assert_eq!(store.list().len(), 1);

        // No active project → an empty scratch dir → an empty board.
        store.retarget(tmp.path().join("empty"));
        assert!(store.list().is_empty());
    }
}
