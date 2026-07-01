//! The `HarnessStore`: the on-disk Harness scan store — a [`RunStore`] over
//! [`HarnessRun`]. The generic run-level CRUD (load/retarget/list/get/upsert, prune to
//! cap history, and reap interrupted `running` scans at boot) is inherited from
//! [`RunStore`]; only the artifact getter here and the finding/artifact lifecycle
//! mutators in the sibling `status` module are Harness-specific.

use super::wire::{HarnessRun, StoredConventionFinding, StoredProposedArtifact};
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

    /// One convention finding within a scan (cloned), if present. The convert-to-task
    /// command reads it to build the minted task's title/description.
    pub fn get_finding(&self, run_id: &str, finding_id: &str) -> Option<StoredConventionFinding> {
        self.read(|runs| {
            runs.get(run_id)
                .and_then(|r| r.findings.iter().find(|f| f.id == finding_id).cloned())
        })
    }

    /// Merge one lens pass's findings into a still-`running` scan so a cancel or crash
    /// keeps the partial findings already paid for. A no-op once the scan leaves
    /// `running`: the terminal `harness-scan-completed` event is authoritative. A
    /// finding whose id is already present is skipped (idempotent re-delivery); a finding
    /// whose fingerprint was dismissed in a prior run stays dismissed. Cost/usage
    /// accumulate so a cancelled scan still shows what it spent (the terminal event
    /// overwrites these totals when the scan completes cleanly).
    pub fn accumulate_findings(
        &self,
        run_id: &str,
        findings: Vec<StoredConventionFinding>,
        dismissed: &std::collections::HashSet<String>,
        cost_usd: f64,
        input_tokens: u64,
        output_tokens: u64,
    ) -> Result<(), String> {
        self.mutate(run_id, |run| {
            if run.status != "running" {
                return;
            }
            // Carry BOTH the status AND any linked task id forward, so a fingerprint
            // converted earlier this scan doesn't lose its link when a later lens
            // re-delivers it (mirrors `InsightStore::accumulate_findings`).
            let prior: std::collections::HashMap<String, (String, Option<String>)> = run
                .findings
                .iter()
                .filter(|f| f.status != "open")
                .map(|f| {
                    (
                        f.fingerprint.clone(),
                        (f.status.clone(), f.linked_task_id.clone()),
                    )
                })
                .collect();
            for mut f in findings {
                if run.findings.iter().any(|e| e.id == f.id) {
                    continue;
                }
                if let Some((status, link)) = prior.get(&f.fingerprint) {
                    f.status = status.clone();
                    f.linked_task_id = link.clone();
                } else if dismissed.contains(&f.fingerprint) {
                    f.status = "dismissed".to_string();
                }
                run.findings.push(f);
            }
            run.cost_usd += cost_usd;
            run.usage.input_tokens += input_tokens;
            run.usage.output_tokens += output_tokens;
        })
        .map(|_| ())
    }
}
