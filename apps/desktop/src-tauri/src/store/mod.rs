//! The on-disk task registry.
//!
//! One compact JSON file per task at
//! `<workspace_root>/.nightcore/tasks/<id>.json`. The store keeps an in-memory
//! map (behind a `Mutex`) as the source of truth for reads, and writes through to
//! disk on every mutation so a restart reloads the exact same board. `.nightcore/`
//! is already gitignored.
//!
//! Held in managed Tauri state; commands take it as `State<'_, TaskStore>`.

pub(crate) mod attachments;
pub(crate) mod board_background;
pub(crate) mod harness;
pub(crate) mod harness_manifest;
pub(crate) mod harness_policy;
pub(crate) mod insight;
pub(crate) mod issue_triage;
pub(crate) mod ledger;
pub(crate) mod model_cache;
pub(crate) mod pr_review;
pub(crate) mod project;
pub(crate) mod project_icon;
pub(crate) mod run_store;
pub(crate) mod scorecard;
pub(crate) mod settings;
pub(crate) mod task;
pub(crate) mod transcript;
pub mod types;

mod atomic;
mod paths;
mod registry;

// Module facade: preserve the historical `crate::store::*` paths after the
// god-file split so external call sites keep resolving unchanged (transcript's
// `is_safe_task_id`, the single-file stores' `write_atomic`/`quarantine_corrupt`,
// `TaskStore`/`workspace_root` everywhere) and the retained `#[cfg(test)]` modules
// keep reaching these items via `use super::*`.
pub(crate) use atomic::{quarantine_corrupt, write_atomic};
pub(crate) use model_cache::{claude_static_catalog, ModelCache, ModelCacheKey};
pub(crate) use paths::is_safe_task_id;
pub use paths::workspace_root;
pub use registry::TaskStore;

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
    fn every_persist_stamps_a_strictly_greater_seq() {
        let (store, _tmp) = temp_store();
        let task = Task::new("t".into(), String::new());
        let id = task.id.clone();

        // First persist stamps seq 1 (pre-increment, so a stamped task is > 0).
        let a = store.upsert(&task).expect("upsert");
        assert_eq!(a.seq, 1, "first persist stamps seq 1");

        // Each subsequent persist (a status change, here) is strictly greater.
        let b = store
            .mutate(&id, |t| t.status = TaskStatus::Ready)
            .expect("mutate");
        assert!(b.seq > a.seq, "a mutate seq advances past the prior");

        let c = store
            .mutate(&id, |t| t.status = TaskStatus::Done)
            .expect("mutate");
        assert!(c.seq > b.seq, "every persist strictly increases seq");

        // The in-memory snapshot reflects the latest stamped seq.
        assert_eq!(store.get(&id).unwrap().seq, c.seq);
    }

    #[test]
    fn seq_resumes_above_the_persisted_high_water_after_reload() {
        let tmp = TempDir::new().expect("create temp dir");
        let dir = tmp.path().join("tasks");

        // Persist a few times to push seq up, then drop the store.
        let last_seq = {
            let store = TaskStore::load_from(dir.clone());
            let task = Task::new("t".into(), String::new());
            let id = task.id.clone();
            store.upsert(&task).expect("upsert");
            store
                .mutate(&id, |t| t.status = TaskStatus::Ready)
                .expect("mutate");
            let final_task = store
                .mutate(&id, |t| t.status = TaskStatus::Done)
                .expect("mutate");
            final_task.seq
        };
        assert!(last_seq >= 3);

        // A fresh load seeds the counter above the on-disk high-water mark, so the
        // next persist out-ranks every reloaded snapshot rather than restarting at 1.
        let reloaded = TaskStore::load_from(dir);
        let any_id = reloaded.list().first().map(|t| t.id.clone()).unwrap();
        let after = reloaded
            .mutate(&any_id, |t| t.title = "edited".into())
            .expect("mutate");
        assert!(
            after.seq > last_seq,
            "seq continues above the persisted high-water mark after reload"
        );
    }

    #[test]
    fn legacy_task_json_without_seq_loads_as_zero() {
        let tmp = TempDir::new().expect("create temp dir");
        let dir = tmp.path().join("tasks");
        std::fs::create_dir_all(&dir).unwrap();
        // A pre-seq task file: a minimal valid Task JSON with no `seq` key.
        let legacy = r#"{
            "id": "legacy-1",
            "title": "old",
            "description": "",
            "status": "backlog",
            "dependencies": [],
            "model": null,
            "branch": null,
            "createdAt": 1,
            "updatedAt": 1,
            "sessionId": null,
            "summary": null,
            "error": null,
            "costUsd": null
        }"#;
        std::fs::write(dir.join("legacy-1.json"), legacy).unwrap();

        let store = TaskStore::load_from(dir);
        let loaded = store.get("legacy-1").expect("legacy task loads");
        assert_eq!(loaded.seq, 0, "missing seq defaults to 0 (serde-additive)");

        // The next persist re-stamps it above the (zero) high-water mark.
        let restamped = store
            .mutate("legacy-1", |t| t.status = TaskStatus::Ready)
            .expect("mutate");
        assert!(
            restamped.seq > 0,
            "a re-persisted legacy task gets a real seq"
        );
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
    fn concurrent_writes_to_different_tasks_all_persist() {
        // The per-task write lock must serialize only same-id writers: many threads
        // each hammering their OWN task must all land correctly, with no cross-task
        // corruption from the shared lock registry. (The old design serialized every
        // write behind one global lock; this asserts the decoupling doesn't drop or
        // scramble writes across tasks.)
        let tmp = TempDir::new().expect("temp dir");
        let store = std::sync::Arc::new(TaskStore::load_from(tmp.path().join("tasks")));

        let n_tasks = 8;
        let iterations = 100;
        let ids: Vec<String> = (0..n_tasks)
            .map(|i| {
                let task = Task::new(format!("t{i}"), String::new());
                let id = task.id.clone();
                store.upsert(&task).expect("seed upsert");
                id
            })
            .collect();

        let handles: Vec<_> = ids
            .iter()
            .map(|id| {
                let s = store.clone();
                // Clone per-thread here (not via `.cloned()` on the iterator): `ids` is
                // still borrowed by the verification loop after the join below.
                let id = id.clone();
                std::thread::spawn(move || {
                    for i in 0..iterations {
                        s.mutate(&id, |t| t.summary = Some(format!("v{i}")))
                            .expect("mutate own task");
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().expect("join");
        }

        // Every task's last write survived, and the on-disk snapshot matches memory.
        let reloaded = TaskStore::load_from(tmp.path().join("tasks"));
        assert_eq!(reloaded.list().len(), n_tasks);
        for id in &ids {
            let mem = store.get(id).expect("in memory");
            let disk = reloaded.get(id).expect("on disk");
            assert_eq!(
                mem.summary.as_deref(),
                Some(format!("v{}", iterations - 1)).as_deref(),
                "each task kept its final write"
            );
            assert_eq!(mem.summary, disk.summary, "memory and disk agree");
        }
    }

    #[test]
    fn remove_and_mutate_same_id_never_resurrect() {
        // The per-id write lock serializes `remove` against a concurrent `mutate` on
        // the same id. Whatever the interleaving, once the record is removed a mutate
        // reads a map-miss and errors instead of re-persisting the deleted task — so
        // the terminal state is deterministically ABSENT in both memory and on disk
        // (no file resurrected behind the delete).
        let tmp = TempDir::new().expect("temp dir");
        let store = std::sync::Arc::new(TaskStore::load_from(tmp.path().join("tasks")));
        let task = Task::new("doomed".into(), String::new());
        let id = task.id.clone();
        store.upsert(&task).expect("upsert");
        let path = tmp.path().join("tasks").join(format!("{id}.json"));

        let s1 = store.clone();
        let id1 = id.clone();
        let mutator = std::thread::spawn(move || {
            // Best-effort mutations; each is Ok until the remove wins, then Err.
            for i in 0..500 {
                let _ = s1.mutate(&id1, |t| t.summary = Some(format!("s{i}")));
            }
        });
        let s2 = store.clone();
        let id2 = id.clone();
        let remover = std::thread::spawn(move || {
            s2.remove(&id2).expect("remove");
        });
        mutator.join().expect("join mutator");
        remover.join().expect("join remover");

        // Drain any straggler mutations that may have been queued behind the remove.
        for i in 0..50 {
            let _ = store.mutate(&id, |t| t.summary = Some(format!("late{i}")));
        }

        assert!(
            store.get(&id).is_none(),
            "removed task stays gone in memory"
        );
        assert!(!path.exists(), "no task file resurrected after the delete");
        // And a fresh load agrees — nothing lingers on disk.
        let reloaded = TaskStore::load_from(tmp.path().join("tasks"));
        assert!(
            reloaded.get(&id).is_none(),
            "removed task absent after reload"
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

    /// The atomic write must land the final file at owner-only (0600) on Unix — the
    /// temp file is created 0600 up front, so a secret-bearing write is never
    /// world-readable, not even during the temp window or after an ill-timed crash.
    #[test]
    #[cfg(unix)]
    fn write_atomic_produces_an_owner_only_file() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().expect("create temp dir");
        let path = tmp.path().join("secret.json");
        write_atomic(&path, b"{\"token\":\"s3cr3t\"}").expect("atomic write");
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "written file must be owner-only, got {:o}",
            mode & 0o777
        );
    }

    /// A persisted task is written as COMPACT JSON (no pretty indentation) yet still
    /// round-trips losslessly through the store on reload. This pins the perf change:
    /// the on-disk format is compact (one line, no `\n  ` indentation), and the record
    /// read back is byte-for-byte the same task — the optimization must not change what
    /// is durably stored.
    #[test]
    fn persisted_task_is_compact_and_round_trips() {
        let tmp = TempDir::new().expect("create temp dir");
        let dir = tmp.path().join("tasks");
        let store = TaskStore::load_from(dir.clone());

        let mut task = Task::new("compact".into(), "some detail".into());
        task.plan = Some("a plan".into());
        store.upsert(&task).expect("upsert");

        // The on-disk file is compact: no pretty-printer indentation ("\n  ").
        let raw =
            std::fs::read_to_string(dir.join(format!("{}.json", task.id))).expect("read file");
        assert!(
            !raw.contains("\n  "),
            "task file must be compact JSON, not pretty-printed: {raw}"
        );

        // And it still deserializes back to the exact same task after a reload.
        let reloaded = TaskStore::load_from(dir);
        let got = reloaded.get(&task.id).expect("task survives reload");
        assert_eq!(got.id, task.id);
        assert_eq!(got.title, task.title);
        assert_eq!(got.plan, task.plan);
    }
}

/// Mechanical layer-boundary guard for `store/`, the Rust analogue of the TS
/// `layer-rank` lint-meta rule.
///
/// The Rust core's dependency direction is fixed: `store/` is the persistence
/// LEAF (on-disk registries, path safety, structure lock), and `commands/`
/// deliberately depends on BOTH persistence and orchestration precisely *so
/// `store/` can stay a pure persistence leaf* (see `commands/mod.rs`). That
/// invariant was enforced by comment only — nothing stopped a helper moved into
/// `store/` from reaching UP into `orchestration/` or `sidecar/`; it would
/// compile and pass CI. This test scans the `store/` source and fails if any
/// real code line imports those upper layers, so a drift reds the gate.
#[cfg(test)]
mod layer_boundary {
    use std::path::{Path, PathBuf};

    /// Every `.rs` file under `src/store`, recursively.
    fn store_sources() -> Vec<PathBuf> {
        let mut out = Vec::new();
        collect(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src/store"),
            &mut out,
        );
        out
    }

    fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("read a store dir") {
            let path = entry.expect("read a store dir entry").path();
            if path.is_dir() {
                collect(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    #[test]
    fn store_does_not_reach_up_into_orchestration_or_sidecar() {
        // The upward layers `store/` must never import. Route any dependency on
        // these through `commands/` (which is allowed to depend on both) so this
        // leaf stays pure persistence. Built via `concat!` so this scanner's own
        // needle literals don't appear whole on one line and flag this file.
        const FORBIDDEN: [&str; 2] = [
            concat!("crate", "::orchestration"),
            concat!("crate", "::sidecar"),
        ];

        let mut offences = Vec::new();
        for file in store_sources() {
            let src = std::fs::read_to_string(&file).expect("read a store source file");
            for (idx, line) in src.lines().enumerate() {
                // Comment lines (incl. `//!`/`///` intra-doc links such as
                // `[crate::sidecar::harness]`) name these paths as prose, not as
                // imports — they are not a layer violation, so skip them.
                if line.trim_start().starts_with("//") {
                    continue;
                }
                for needle in FORBIDDEN {
                    if line.contains(needle) {
                        offences.push(format!("{}:{}: {}", file.display(), idx + 1, line.trim()));
                    }
                }
            }
        }

        assert!(
            offences.is_empty(),
            "store/ is the persistence leaf and must not import orchestration/ or \
             sidecar/ — route such dependencies through commands/. Offending \
             line(s):\n{}",
            offences.join("\n")
        );
    }
}
