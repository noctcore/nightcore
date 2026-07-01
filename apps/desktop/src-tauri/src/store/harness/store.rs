//! The `HarnessStore`: the on-disk Harness scan store — a [`RunStore`] over
//! [`HarnessRun`]. The generic run-level CRUD (load/retarget/list/get/upsert, prune to
//! cap history, and reap interrupted `running` scans at boot) is inherited from
//! [`RunStore`]; only the artifact getter here and the finding/artifact lifecycle
//! mutators in the sibling `status` module are Harness-specific.

use super::wire::{HarnessRun, StoredProposedArtifact};
use crate::store::run_store::{PersistedRun, RunStore};

/// The Harness scan store. See the module docs — the run-level CRUD and its
/// correctness-sensitive invariants (disk-first upsert, prune-by-age, boot reap,
/// lock-under-mutate) live once on [`RunStore`].
pub type HarnessStore = RunStore<HarnessRun>;

impl PersistedRun for HarnessRun {
    const RUN_LABEL: &'static str = "harness run";
    const DIR_LABEL: &'static str = "harness";
    const INTERRUPTED_ERROR: &'static str = "interrupted (app restarted mid-scan)";

    fn id(&self) -> &str {
        &self.id
    }
    fn created_at(&self) -> u64 {
        self.created_at
    }
    fn status(&self) -> &str {
        &self.status
    }
    fn set_status(&mut self, status: &str) {
        self.status = status.to_string();
    }
    fn set_error(&mut self, error: Option<String>) {
        self.error = error;
    }
    fn set_updated_at(&mut self, updated_at: u64) {
        self.updated_at = updated_at;
    }
}

impl HarnessStore {
    /// One artifact within a scan (cloned), if present.
    pub fn get_artifact(&self, run_id: &str, artifact_id: &str) -> Option<StoredProposedArtifact> {
        self.read(|runs| {
            runs.get(run_id)
                .and_then(|r| r.artifacts.iter().find(|a| a.id == artifact_id).cloned())
        })
    }
}
