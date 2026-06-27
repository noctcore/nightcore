//! The `HarnessStore`: the in-memory scan map + write-through-to-disk CRUD, plus
//! prune (cap history) and reap (fail interrupted `running` scans at boot).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use super::wire::{HarnessRun, StoredProposedArtifact};
use crate::store::{is_safe_task_id, write_atomic};

/// Keep at most this many scans per project on disk + in memory; `upsert` prunes the
/// oldest beyond it so harness history can't grow unbounded across re-runs.
const MAX_RUNS: usize = 50;

/// The in-memory scan map plus the directory it persists to (interior-mutable so it
/// can be retargeted on project switch).
pub struct HarnessStore {
    pub(super) runs: Mutex<HashMap<String, HarnessRun>>,
    dir: Mutex<PathBuf>,
}

fn read_runs_into_map(dir: &PathBuf) -> HashMap<String, HarnessRun> {
    if let Err(e) = std::fs::create_dir_all(dir) {
        tracing::warn!(target: "nightcore::store", dir = %dir.display(), error = %e, "failed to create harness dir");
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
                    Ok(raw) => match serde_json::from_str::<HarnessRun>(&raw) {
                        Ok(run) => {
                            runs.insert(run.id.clone(), run);
                        }
                        Err(e) => {
                            tracing::warn!(target: "nightcore::store", path = %path.display(), error = %e, "skipping unparsable harness run")
                        }
                    },
                    Err(e) => {
                        tracing::warn!(target: "nightcore::store", path = %path.display(), error = %e, "cannot read harness run file")
                    }
                }
            }
        }
        Err(e) => {
            tracing::warn!(target: "nightcore::store", dir = %dir.display(), error = %e, "cannot list harness dir")
        }
    }
    runs
}

impl HarnessStore {
    /// Load every scan file under `dir` into memory, creating the dir if missing.
    pub fn load_from(dir: PathBuf) -> Self {
        let runs = read_runs_into_map(&dir);
        Self {
            runs: Mutex::new(runs),
            dir: Mutex::new(dir),
        }
    }

    /// Re-point the store at `dir` (project switch), clearing + reloading.
    pub fn retarget(&self, dir: PathBuf) {
        let reloaded = read_runs_into_map(&dir);
        *crate::sync::lock_or_recover(&self.runs) = reloaded;
        *crate::sync::lock_or_recover(&self.dir) = dir;
    }

    fn path_for(&self, id: &str) -> Result<PathBuf, String> {
        if !is_safe_task_id(id) {
            return Err(format!("invalid run id: {id}"));
        }
        Ok(crate::sync::lock_or_recover(&self.dir).join(format!("{id}.json")))
    }

    /// All scans, newest first (by `created_at`).
    pub fn list(&self) -> Vec<HarnessRun> {
        let mut runs: Vec<HarnessRun> = crate::sync::lock_or_recover(&self.runs)
            .values()
            .cloned()
            .collect();
        runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        runs
    }

    /// A single scan by id.
    pub fn get(&self, id: &str) -> Option<HarnessRun> {
        crate::sync::lock_or_recover(&self.runs).get(id).cloned()
    }

    pub(super) fn persist(&self, run: &HarnessRun) -> Result<(), String> {
        let path = self.path_for(&run.id)?;
        let json = serde_json::to_string_pretty(run).map_err(|e| e.to_string())?;
        write_atomic(&path, json.as_bytes())
            .map_err(|e| format!("failed to persist harness run {}: {e}", run.id))
    }

    /// Insert or replace a scan and write its file, then prune the oldest beyond [`MAX_RUNS`].
    pub fn upsert(&self, run: &HarnessRun) -> Result<(), String> {
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        self.persist(run)?;
        guard.insert(run.id.clone(), run.clone());
        self.prune_locked(&mut guard);
        Ok(())
    }

    fn prune_locked(&self, guard: &mut std::sync::MutexGuard<'_, HashMap<String, HarnessRun>>) {
        if guard.len() <= MAX_RUNS {
            return;
        }
        let mut by_age: Vec<(String, u64)> = guard
            .values()
            .map(|r| (r.id.clone(), r.created_at))
            .collect();
        by_age.sort_by_key(|(_, created)| *created);
        let to_remove = guard.len().saturating_sub(MAX_RUNS);
        for (id, _) in by_age.into_iter().take(to_remove) {
            guard.remove(&id);
            if let Ok(path) = self.path_for(&id) {
                if let Err(e) = std::fs::remove_file(&path) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(target: "nightcore::store", run_id = %id, error = %e, "failed to prune old harness run file");
                    }
                }
            }
        }
    }

    /// Mark every scan still `running` as `failed("interrupted")` — a `running` scan at
    /// BOOT died with the previous process, so it can never complete. Boot-only.
    pub fn reap_running(&self) {
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        let stale: Vec<String> = guard
            .values()
            .filter(|r| r.status == "running")
            .map(|r| r.id.clone())
            .collect();
        for id in stale {
            if let Some(run) = guard.get_mut(&id) {
                run.status = "failed".to_string();
                run.error = Some("interrupted (app restarted mid-scan)".to_string());
                run.updated_at = crate::task::now_ms();
                let snapshot = run.clone();
                let _ = self.persist(&snapshot);
            }
        }
    }

    /// Delete a scan from memory and disk. Idempotent on a missing file.
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

    /// Apply `f` to a scan, bump `updated_at`, persist, and return it — all under one lock.
    pub fn mutate<F>(&self, id: &str, f: F) -> Result<HarnessRun, String>
    where
        F: FnOnce(&mut HarnessRun),
    {
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        let mut run = guard
            .get(id)
            .cloned()
            .ok_or_else(|| format!("no harness run with id {id}"))?;
        f(&mut run);
        run.updated_at = crate::task::now_ms();
        let path = self.path_for(&run.id)?;
        let json = serde_json::to_string_pretty(&run).map_err(|e| e.to_string())?;
        write_atomic(&path, json.as_bytes())
            .map_err(|e| format!("failed to persist harness run {}: {e}", run.id))?;
        guard.insert(run.id.clone(), run.clone());
        Ok(run)
    }

    /// One artifact within a scan (cloned), if present.
    pub fn get_artifact(&self, run_id: &str, artifact_id: &str) -> Option<StoredProposedArtifact> {
        crate::sync::lock_or_recover(&self.runs)
            .get(run_id)
            .and_then(|r| r.artifacts.iter().find(|a| a.id == artifact_id).cloned())
    }
}
