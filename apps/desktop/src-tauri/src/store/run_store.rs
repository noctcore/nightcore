//! The generic JSON-file-backed run store shared by the three "scan" features
//! (Insight, Readiness Scorecard, Harness).
//!
//! Each feature's `*Store` is a [`RunStore<TheirRun>`] type alias; this module owns
//! the correctness-sensitive run-level CRUD in exactly ONE audited place:
//!   - disk-first `upsert_if_idle` ordering (persist, then insert, then prune),
//!   - the prune-by-age cap ([`MAX_RUNS`]),
//!   - the boot-only `reap_running` interrupt-marking,
//!   - and the load → mutate → persist → reinsert lock discipline (`edit_run`).
//!
//! Feature-specific per-item lifecycle mutators (finding / reading / artifact status,
//! convert-to-task links, cross-run fingerprint carry-forward) live in each feature
//! module and reach the run map through the two `pub(crate)` seams
//! [`RunStore::edit_run`] (mutating) and [`RunStore::read`] (read-only), so the
//! atomic-write and lock-ordering invariants are never re-implemented per feature.
//!
//! NB: the sibling `crate::sidecar::scan` module owns a *different* `ScanRun` / `ScanStore`
//! pair — the terminal-event finalizer over already-loaded runs. This module is the
//! store-layer refactor that module's docs anticipated ("the store-trait refactor is a
//! separate finding"); the two abstractions are intentionally distinct and non-colliding.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::store::insight::LinkOutcome;
use crate::store::{is_safe_task_id, write_atomic};

/// Keep at most this many runs per project on disk + in memory; [`RunStore::upsert_if_idle`]
/// prunes the oldest beyond it so run history (and its resident item `Vec`s) can't
/// grow unbounded across re-runs.
pub(crate) const MAX_RUNS: usize = 50;

/// A run persisted by [`RunStore`]: the minimal shape the generic CRUD needs — a stable
/// id, a creation timestamp for age-ordering, and mutable status/error/updated_at for the
/// boot reaper and the mutate path. The associated consts carry the per-feature log and
/// error nouns so the (previously triplicated) message text is preserved without any
/// per-feature code.
pub trait PersistedRun: Clone + Serialize + DeserializeOwned {
    /// Singular run noun for error/log strings, e.g. `"insight run"`.
    const RUN_LABEL: &'static str;
    /// Directory noun for dir-level log lines, e.g. `"insights"` (harness uses `"harness"`).
    const DIR_LABEL: &'static str;
    /// Error stamped on a run reaped at boot, e.g. `"interrupted (app restarted mid-analysis)"`.
    const INTERRUPTED_ERROR: &'static str;

    fn id(&self) -> &str;
    fn created_at(&self) -> u64;
    fn status(&self) -> &str;
    fn set_status(&mut self, status: &str);
    fn set_error(&mut self, error: Option<String>);
    fn set_updated_at(&mut self, updated_at: u64);
}

/// The disposition an [`RunStore::edit_run`] closure returns. `Commit` bumps
/// `updated_at` and writes the run through to disk; `Skip` is an idempotent no-op that
/// persists nothing (the `AlreadyLinked` / `AlreadyApplied` short-circuits). Both carry
/// the caller's own return value back out.
pub enum Edit<T> {
    Commit(T),
    Skip(T),
}

/// The in-memory run map plus the directory it persists to (interior-mutable so it can
/// be retargeted on project switch). The `dir` lives behind its own `Mutex` so
/// `path_for` can be taken without holding the `runs` lock.
pub struct RunStore<R: PersistedRun> {
    runs: Mutex<HashMap<String, R>>,
    dir: Mutex<PathBuf>,
}

fn read_runs_into_map<R: PersistedRun>(dir: &PathBuf) -> HashMap<String, R> {
    if let Err(e) = std::fs::create_dir_all(dir) {
        tracing::warn!(target: "nightcore::store", dir = %dir.display(), error = %e, "failed to create {} dir", R::DIR_LABEL);
    }
    let mut runs = HashMap::new();
    match std::fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                match std::fs::read_to_string(&path) {
                    Ok(raw) => match serde_json::from_str::<R>(&raw) {
                        Ok(run) => {
                            runs.insert(run.id().to_string(), run);
                        }
                        Err(e) => {
                            tracing::warn!(target: "nightcore::store", path = %path.display(), error = %e, "skipping unparsable {}", R::RUN_LABEL)
                        }
                    },
                    Err(e) => {
                        tracing::warn!(target: "nightcore::store", path = %path.display(), error = %e, "cannot read {} file", R::RUN_LABEL)
                    }
                }
            }
        }
        Err(e) => {
            tracing::warn!(target: "nightcore::store", dir = %dir.display(), error = %e, "cannot list {} dir", R::DIR_LABEL)
        }
    }
    runs
}

impl<R: PersistedRun> RunStore<R> {
    /// Load every run file under `dir` into memory, creating the dir if missing.
    pub fn load_from(dir: PathBuf) -> Self {
        let runs = read_runs_into_map::<R>(&dir);
        Self {
            runs: Mutex::new(runs),
            dir: Mutex::new(dir),
        }
    }

    /// Re-point the store at `dir` (project switch), clearing + reloading. Existing
    /// files on disk are untouched.
    pub fn retarget(&self, dir: PathBuf) {
        let reloaded = read_runs_into_map::<R>(&dir);
        *crate::sync::lock_or_recover(&self.runs) = reloaded;
        *crate::sync::lock_or_recover(&self.dir) = dir;
    }

    fn path_for(&self, id: &str) -> Result<PathBuf, String> {
        if !is_safe_task_id(id) {
            return Err(format!("invalid run id: {id}"));
        }
        Ok(crate::sync::lock_or_recover(&self.dir).join(format!("{id}.json")))
    }

    /// All runs, newest first (by `created_at`).
    pub fn list(&self) -> Vec<R> {
        let mut runs: Vec<R> = crate::sync::lock_or_recover(&self.runs)
            .values()
            .cloned()
            .collect();
        // Newest first (descending `created_at`).
        runs.sort_by_key(|r| std::cmp::Reverse(r.created_at()));
        runs
    }

    /// A single run by id.
    pub fn get(&self, id: &str) -> Option<R> {
        crate::sync::lock_or_recover(&self.runs).get(id).cloned()
    }

    /// Serialize + atomically write one run to its file. The caller holds the `runs`
    /// lock; this only touches the (separate) `dir` lock via `path_for`.
    fn persist(&self, run: &R) -> Result<(), String> {
        let path = self.path_for(run.id())?;
        // Compact, not pretty: a scan run re-serializes its ENTIRE accumulating set of
        // findings on every `*-category-completed` event, and the file is only read
        // back by serde — the pretty-printer's indentation over a growing run is pure
        // per-event overhead on the hot orchestration path.
        let json = serde_json::to_string(run).map_err(|e| e.to_string())?;
        write_atomic(&path, json.as_bytes())
            .map_err(|e| format!("failed to persist {} {}: {e}", R::RUN_LABEL, run.id()))
    }

    /// Unconditional insert-or-replace (persist, insert, prune) — the test-seeding
    /// escape hatch. Production run creation goes through [`RunStore::upsert_if_idle`]
    /// so the single-flight guard can't be bypassed outside tests.
    #[cfg(test)]
    pub fn upsert(&self, run: &R) -> Result<(), String> {
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        self.persist(run)?;
        guard.insert(run.id().to_string(), run.clone());
        self.prune_locked(&mut guard);
        Ok(())
    }

    /// Insert a fresh run ONLY if no other run is currently `running` — the single-flight
    /// guard that stops a second concurrent (paid) scan from launching for this project
    /// (e.g. picking "New run" or a history entry while a scan streams). The
    /// store-wide (`|_| true`) case of [`RunStore::upsert_if_idle_when`]; scan kinds
    /// whose runs never overlap keep this blanket guard.
    pub fn upsert_if_idle(&self, run: &R, busy_msg: &str) -> Result<(), String> {
        self.upsert_if_idle_when(run, |_| true, busy_msg)
    }

    /// Insert a fresh run ONLY if no `running` run matches `conflicts` — the scoped
    /// single-flight guard for kinds whose runs may legitimately overlap (PR reviews
    /// serialize per `pr_number`, not per store, so two DIFFERENT PRs can review
    /// concurrently while a duplicate start on the SAME PR is still refused). Atomic:
    /// the running-check and the insert happen under ONE `runs` lock, so two racing
    /// `start_*` commands (Tauri runs them on a thread pool) can't both pass — the
    /// same invariant whichever predicate a kind uses. Returns `Err(busy_msg)` when a
    /// conflicting run is already active. A run stuck `running` from a crashed process
    /// is cleared by [`reap_running`] at the next boot.
    pub fn upsert_if_idle_when<F>(
        &self,
        run: &R,
        conflicts: F,
        busy_msg: &str,
    ) -> Result<(), String>
    where
        F: Fn(&R) -> bool,
    {
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        if guard
            .values()
            .any(|r| r.status() == "running" && conflicts(r))
        {
            return Err(busy_msg.to_string());
        }
        self.persist(run)?;
        guard.insert(run.id().to_string(), run.clone());
        self.prune_locked(&mut guard);
        Ok(())
    }

    /// Drop the oldest runs (by `created_at`) beyond [`MAX_RUNS`], deleting their files.
    /// Called under the `runs` lock from `upsert_if_idle_when`. Best-effort on the file delete
    /// (a failed unlink is logged, not fatal — the in-memory cap still holds).
    ///
    /// A `running` run is NEVER evicted: kinds whose runs may legitimately overlap
    /// (PR reviews serialize per PR, not per store) can hold several concurrent
    /// `running` entries, and pruning one mid-flight would strand its live scan —
    /// terminal events land on a run the store no longer knows (and its findings
    /// vanish from the UI). Only settled runs age out; in the absurd case where
    /// 50+ runs are all `running`, nothing is pruned (the cap yields to liveness).
    fn prune_locked(&self, guard: &mut MutexGuard<'_, HashMap<String, R>>) {
        if guard.len() <= MAX_RUNS {
            return;
        }
        let mut by_age: Vec<(String, u64)> = guard
            .values()
            .filter(|r| r.status() != "running")
            .map(|r| (r.id().to_string(), r.created_at()))
            .collect();
        by_age.sort_by_key(|(_, created)| *created);
        let to_remove = guard.len().saturating_sub(MAX_RUNS);
        for (id, _) in by_age.into_iter().take(to_remove) {
            guard.remove(&id);
            if let Ok(path) = self.path_for(&id) {
                if let Err(e) = std::fs::remove_file(&path) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(target: "nightcore::store", run_id = %id, error = %e, "failed to prune old {} file", R::RUN_LABEL);
                    }
                }
            }
        }
    }

    /// Mark every run still in `running` as `failed` (with [`PersistedRun::INTERRUPTED_ERROR`])
    /// and persist. A `running` run at BOOT means the work died with the previous process,
    /// so it can never complete — reaping it stops the UI from spinning forever. Call ONLY
    /// on boot, never on a project switch (a cross-project run may still be live).
    pub fn reap_running(&self) {
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        let stale: Vec<String> = guard
            .values()
            .filter(|r| r.status() == "running")
            .map(|r| r.id().to_string())
            .collect();
        for id in stale {
            if let Some(run) = guard.get_mut(&id) {
                run.set_status("failed");
                run.set_error(Some(R::INTERRUPTED_ERROR.to_string()));
                run.set_updated_at(crate::task::now_ms());
                let snapshot = run.clone();
                let _ = self.persist(&snapshot);
            }
        }
    }

    /// Delete a run from memory and disk. Idempotent on a missing file.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let path = self.path_for(id)?;
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        guard.remove(id);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("failed to delete {}: {e}", path.display())),
        }
    }

    /// Apply `f` to a run, bump `updated_at`, persist, and return it — all under one lock
    /// (so a concurrent finalize/dismiss can't interleave a stale read-write).
    pub fn mutate<F>(&self, id: &str, f: F) -> Result<R, String>
    where
        F: FnOnce(&mut R),
    {
        let (_, run) = self.edit_run(id, |run| {
            f(run);
            Ok(Edit::Commit(()))
        })?;
        Ok(run)
    }

    /// The generic core of every per-item lifecycle mutator: load run `id` (Err — using
    /// [`PersistedRun::RUN_LABEL`] — if unknown), apply `edit`, then per its returned
    /// [`Edit`] either commit (bump `updated_at`, persist, reinsert) or skip (an
    /// idempotent no-op that persists nothing) — ALL under one `runs` lock. Returns the
    /// closure's value alongside the (possibly-updated) run.
    ///
    /// `edit` may return `Err` (e.g. the item wasn't found) to abort with no persist,
    /// exactly like the hand-written mutators this replaces.
    pub(crate) fn edit_run<T, F>(&self, id: &str, edit: F) -> Result<(T, R), String>
    where
        F: FnOnce(&mut R) -> Result<Edit<T>, String>,
    {
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        let mut run = guard
            .get(id)
            .cloned()
            .ok_or_else(|| format!("no {} with id {id}", R::RUN_LABEL))?;
        match edit(&mut run)? {
            Edit::Skip(value) => Ok((value, run)),
            Edit::Commit(value) => {
                run.set_updated_at(crate::task::now_ms());
                self.persist(&run)?;
                guard.insert(run.id().to_string(), run.clone());
                Ok((value, run))
            }
        }
    }

    /// Read-only access to the run map under the lock — for the single-item getters and
    /// the cross-run scans (dismissed fingerprints, prior artifact states).
    pub(crate) fn read<T>(&self, f: impl FnOnce(&HashMap<String, R>) -> T) -> T {
        f(&crate::sync::lock_or_recover(&self.runs))
    }

    /// Set one lifecycle item's status (and optionally its linked task) under one lock,
    /// persisting the run. Errors — using `item_noun` — if the run OR the item is
    /// unknown, so a missing item never reports phantom success (which would let the
    /// convert path believe an item was linked when it wasn't, minting a duplicate task
    /// on the next click). `select` picks the item collection out of the run (findings /
    /// readings / proposals). The single audited home of the per-item set-status write.
    pub(crate) fn set_item_status<I, S>(
        &self,
        run_id: &str,
        item_id: &str,
        item_noun: &str,
        status: &str,
        linked_task_id: Option<Option<String>>,
        select: S,
    ) -> Result<R, String>
    where
        I: LifecycleItem,
        S: FnOnce(&mut R) -> &mut Vec<I>,
    {
        let (_, run) = self.edit_run(run_id, |run| {
            let item = select(run)
                .iter_mut()
                .find(|i| i.id() == item_id)
                .ok_or_else(|| format!("no {item_noun} {item_id} in run {run_id}"))?;
            item.set_status(status);
            if let Some(link) = linked_task_id {
                item.set_linked_task_id(link);
            }
            Ok(Edit::Commit(()))
        })?;
        Ok(run)
    }

    /// Atomically link one lifecycle item to a task under ONE lock: if it is already
    /// linked return [`LinkOutcome::AlreadyLinked`] (the caller discards its freshly-minted
    /// task and returns the existing one); otherwise stamp it `converted` + linked and
    /// return [`LinkOutcome::Linked`]. This closes the convert-to-task TOCTOU — a
    /// check-then-set split across two lock acquisitions would let two concurrent sync
    /// Tauri commands both see `linked_task_id == None` and mint two tasks. The single
    /// audited home of that check-and-set.
    pub(crate) fn link_item_task<I, S>(
        &self,
        run_id: &str,
        item_id: &str,
        item_noun: &str,
        task_id: &str,
        select: S,
    ) -> Result<LinkOutcome, String>
    where
        I: LifecycleItem,
        S: FnOnce(&mut R) -> &mut Vec<I>,
    {
        let (outcome, _) = self.edit_run(run_id, |run| {
            let item = select(run)
                .iter_mut()
                .find(|i| i.id() == item_id)
                .ok_or_else(|| format!("no {item_noun} {item_id} in run {run_id}"))?;
            if let Some(existing) = item.linked_task_id() {
                return Ok(Edit::Skip(LinkOutcome::AlreadyLinked(existing.to_string())));
            }
            item.set_status("converted");
            item.set_linked_task_id(Some(task_id.to_string()));
            Ok(Edit::Commit(LinkOutcome::Linked))
        })?;
        Ok(outcome)
    }

    /// Every fingerprint a user has CONVERTED to a task across all runs (optionally
    /// excluding `except_run`), mapped to the linked task id. Carries convert-history
    /// forward so a re-discovered item whose fingerprint was already converted stays
    /// `converted` + linked (when its task still lives) instead of re-surfacing `open`
    /// and being re-minted on every re-run. `select` picks the item collection out of
    /// each run; the caller checks task liveness.
    pub(crate) fn converted_item_fingerprints<I, S>(
        &self,
        except_run: Option<&str>,
        select: S,
    ) -> HashMap<String, String>
    where
        I: LifecycleItem,
        S: Fn(&R) -> &[I],
    {
        self.read(|runs| {
            let mut map = HashMap::new();
            for run in runs.values() {
                if Some(run.id()) == except_run {
                    continue;
                }
                for item in select(run) {
                    if item.status() == "converted" {
                        if let Some(task_id) = item.linked_task_id() {
                            map.insert(item.fingerprint().to_string(), task_id.to_string());
                        }
                    }
                }
            }
            map
        })
    }

    /// Every fingerprint a user has DISMISSED across all runs (optionally excluding
    /// `except_run`). Carries dismissed-history forward so a re-discovered item whose
    /// fingerprint was previously dismissed stays dismissed. `select` picks the item
    /// collection out of each run.
    pub(crate) fn dismissed_item_fingerprints<I, S>(
        &self,
        except_run: Option<&str>,
        select: S,
    ) -> HashSet<String>
    where
        I: LifecycleItem,
        S: Fn(&R) -> &[I],
    {
        self.read(|runs| {
            let mut set = HashSet::new();
            for run in runs.values() {
                if Some(run.id()) == except_run {
                    continue;
                }
                for item in select(run) {
                    if item.status() == "dismissed" {
                        set.insert(item.fingerprint().to_string());
                    }
                }
            }
            set
        })
    }
}

/// A per-run lifecycle item (a finding / reading / proposal) the generic item mutators
/// operate over: it exposes exactly the fields the shared status / convert-link /
/// fingerprint-carry logic touches, so the concurrency-sensitive check-and-set lives in
/// exactly ONE audited place ([`RunStore::link_item_task`]) instead of a hand-cloned copy
/// per scan store.
pub(crate) trait LifecycleItem {
    fn id(&self) -> &str;
    fn status(&self) -> &str;
    fn set_status(&mut self, status: &str);
    fn fingerprint(&self) -> &str;
    fn linked_task_id(&self) -> Option<&str>;
    fn set_linked_task_id(&mut self, task_id: Option<String>);
}

/// The single registry of run-based "scan" store kinds — one `($Run:ty, $slug:literal)`
/// row per kind, where `$slug` is both the on-disk dir name (`.nightcore/<slug>`) and
/// the no-active-project scratch name. Every place that must touch each kind in
/// parallel — the boot path (`lib.rs`: resolve dir → `load_from` → `reap_running` →
/// `app.manage`) and the project-switch retarget ([`crate::commands::project`]) —
/// iterates THIS list through a per-kind callback macro, so adding a scan kind is a
/// single line here instead of a scatter of parallel edits.
///
/// Invoke as `scan_kinds!(cb)` where `cb` is a `macro_rules!` accepting
/// `($Run:ty, $slug:literal)`; it is expanded once per registered kind. (Tauri's
/// `generate_handler!` still needs each command path spelled out explicitly — that
/// one list is the only per-kind wiring this table can't absorb, since a proc-macro
/// won't expand a nested macro in its input.)
macro_rules! scan_kinds {
    ($cb:ident) => {
        $cb!(crate::store::insight::InsightRun, "insights");
        $cb!(crate::store::harness::HarnessRun, "harness");
        $cb!(crate::store::scorecard::ScorecardRun, "scorecards");
        $cb!(crate::store::pr_review::PrReviewRun, "pr-reviews");
    };
}
pub(crate) use scan_kinds;
