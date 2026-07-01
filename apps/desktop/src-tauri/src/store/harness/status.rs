//! Lifecycle mutation for findings/artifacts, plus the cross-run fingerprint
//! carry-forward (`dismissed_finding_fingerprints`, `prior_artifact_states`) that lets a
//! re-scan inherit the user's prior dismiss/apply edits instead of re-proposing them.

use std::collections::{HashMap, HashSet};

use super::store::HarnessStore;
use super::wire::HarnessRun;
// Reuse Insight's convert-to-task outcome enum rather than duplicating it — the same
// precedent as `FindingLocation`, so both features share ONE `LinkOutcome`. Re-exported
// (`pub use`) so it flows through the `harness::*` facade for `commands.rs` + tests.
pub use crate::store::insight::LinkOutcome;
use crate::store::run_store::Edit;

/// The result of an atomic artifact-apply transition (see [`HarnessStore::mark_artifact_applied`]).
pub enum ApplyOutcome {
    /// The artifact was `proposed` and is now `applied` + records its written path.
    Applied,
    /// The artifact was ALREADY `applied` (idempotent re-apply) — the caller should
    /// NOT re-write the file; the existing applied path is returned.
    AlreadyApplied(String),
}

impl HarnessStore {
    /// Set a convention finding's status (`open` | `dismissed` | `converted`),
    /// persisting the scan. `linked_task_id` is `Some(link)` to also (re)set the linked
    /// task (outer `None` leaves it untouched, so dismiss/restore never disturb a link).
    /// Errors if the run OR the finding is unknown — a missing finding must not report
    /// phantom success (a silent no-op here would let the convert path believe a finding
    /// was linked when it wasn't, minting a duplicate task on the next click).
    pub fn set_finding_status(
        &self,
        run_id: &str,
        finding_id: &str,
        status: &str,
        linked_task_id: Option<Option<String>>,
    ) -> Result<HarnessRun, String> {
        let (_, run) = self.edit_run(run_id, |run| {
            let finding = run
                .findings
                .iter_mut()
                .find(|f| f.id == finding_id)
                .ok_or_else(|| format!("no finding {finding_id} in run {run_id}"))?;
            finding.status = status.to_string();
            if let Some(link) = linked_task_id {
                finding.linked_task_id = link;
            }
            Ok(Edit::Commit(()))
        })?;
        Ok(run)
    }

    /// Atomically link a convention finding to a task: under ONE lock, if the finding is
    /// already linked return [`LinkOutcome::AlreadyLinked`] (the caller discards its
    /// freshly-minted task and returns the existing one); otherwise stamp it `converted`
    /// + linked and return [`LinkOutcome::Linked`]. Cloned from `InsightStore` — the same
    /// convert-to-task TOCTOU applies: two concurrent sync Tauri commands would both see
    /// `linked_task_id == None` and mint two tasks if the check-and-set were split.
    pub fn link_finding_task(
        &self,
        run_id: &str,
        finding_id: &str,
        task_id: &str,
    ) -> Result<LinkOutcome, String> {
        let (outcome, _) = self.edit_run(run_id, |run| {
            let finding = run
                .findings
                .iter_mut()
                .find(|f| f.id == finding_id)
                .ok_or_else(|| format!("no finding {finding_id} in run {run_id}"))?;
            if let Some(existing) = &finding.linked_task_id {
                return Ok(Edit::Skip(LinkOutcome::AlreadyLinked(existing.clone())));
            }
            finding.status = "converted".to_string();
            finding.linked_task_id = Some(task_id.to_string());
            Ok(Edit::Commit(LinkOutcome::Linked))
        })?;
        Ok(outcome)
    }

    /// Set a proposal's status (`proposed` | `dismissed` | `converted`), persisting the
    /// scan. `linked_task_id` is `Some(link)` to also (re)set the linked task (outer `None`
    /// leaves it untouched, so dismiss/restore never disturb a link). Errors if the run OR
    /// the proposal is unknown — the proposal twin of [`set_finding_status`].
    pub fn set_proposal_status(
        &self,
        run_id: &str,
        proposal_id: &str,
        status: &str,
        linked_task_id: Option<Option<String>>,
    ) -> Result<HarnessRun, String> {
        let (_, run) = self.edit_run(run_id, |run| {
            let proposal = run
                .proposals
                .iter_mut()
                .find(|p| p.id == proposal_id)
                .ok_or_else(|| format!("no proposal {proposal_id} in run {run_id}"))?;
            proposal.status = status.to_string();
            if let Some(link) = linked_task_id {
                proposal.linked_task_id = link;
            }
            Ok(Edit::Commit(()))
        })?;
        Ok(run)
    }

    /// Atomically link a proposal to a task: under ONE lock, if already linked return
    /// [`LinkOutcome::AlreadyLinked`]; otherwise stamp it `converted` + linked and return
    /// [`LinkOutcome::Linked`]. The proposal twin of [`link_finding_task`] — same
    /// convert-to-task TOCTOU guard (two concurrent sync commands can't mint two tasks).
    pub fn link_proposal_task(
        &self,
        run_id: &str,
        proposal_id: &str,
        task_id: &str,
    ) -> Result<LinkOutcome, String> {
        let (outcome, _) = self.edit_run(run_id, |run| {
            let proposal = run
                .proposals
                .iter_mut()
                .find(|p| p.id == proposal_id)
                .ok_or_else(|| format!("no proposal {proposal_id} in run {run_id}"))?;
            if let Some(existing) = &proposal.linked_task_id {
                return Ok(Edit::Skip(LinkOutcome::AlreadyLinked(existing.clone())));
            }
            proposal.status = "converted".to_string();
            proposal.linked_task_id = Some(task_id.to_string());
            Ok(Edit::Commit(LinkOutcome::Linked))
        })?;
        Ok(outcome)
    }

    /// Set an artifact's status to `proposed` or `dismissed`, persisting the scan. Used by
    /// dismiss/restore; the `applied` transition goes through [`mark_artifact_applied`].
    pub fn set_artifact_status(
        &self,
        run_id: &str,
        artifact_id: &str,
        status: &str,
    ) -> Result<HarnessRun, String> {
        let (_, run) = self.edit_run(run_id, |run| {
            let artifact = run
                .artifacts
                .iter_mut()
                .find(|a| a.id == artifact_id)
                .ok_or_else(|| format!("no artifact {artifact_id} in run {run_id}"))?;
            // Transitioning AWAY from `applied` (dismiss/restore of a written
            // artifact) must clear the applied metadata, else the record keeps a
            // dangling `applied_path`/`applied_at` and `prior_artifact_states` would
            // mis-rank a re-proposed artifact whose file is no longer tracked.
            if artifact.status == "applied" && status != "applied" {
                artifact.applied_path = None;
                artifact.applied_at = None;
            }
            artifact.status = status.to_string();
            Ok(Edit::Commit(()))
        })?;
        Ok(run)
    }

    /// Atomically record that an artifact was written to disk: under ONE lock, if it is
    /// already `applied` return [`ApplyOutcome::AlreadyApplied`] (the caller must NOT
    /// re-write); otherwise stamp it `applied` + record `applied_path`/`applied_at` and
    /// return [`ApplyOutcome::Applied`]. The caller writes the file FIRST (the filesystem
    /// no-clobber on `create` is the real double-write guard) then calls this to commit
    /// the status; the check-and-set here keeps the lifecycle transition itself atomic.
    pub fn mark_artifact_applied(
        &self,
        run_id: &str,
        artifact_id: &str,
        applied_path: &str,
    ) -> Result<(ApplyOutcome, HarnessRun), String> {
        self.edit_run(run_id, |run| {
            let artifact = run
                .artifacts
                .iter_mut()
                .find(|a| a.id == artifact_id)
                .ok_or_else(|| format!("no artifact {artifact_id} in run {run_id}"))?;
            if artifact.status == "applied" {
                let existing = artifact
                    .applied_path
                    .clone()
                    .unwrap_or_else(|| applied_path.to_string());
                return Ok(Edit::Skip(ApplyOutcome::AlreadyApplied(existing)));
            }
            artifact.status = "applied".to_string();
            artifact.applied_path = Some(applied_path.to_string());
            artifact.applied_at = Some(crate::task::now_ms());
            Ok(Edit::Commit(ApplyOutcome::Applied))
        })
    }

    /// Every fingerprint a user has DISMISSED across all scans (optionally excluding
    /// `except_run`). Carries dismissed-history forward for convention findings.
    pub fn dismissed_finding_fingerprints(&self, except_run: Option<&str>) -> HashSet<String> {
        self.read(|runs| {
            let mut set = HashSet::new();
            for run in runs.values() {
                if Some(run.id.as_str()) == except_run {
                    continue;
                }
                for f in &run.findings {
                    if f.status == "dismissed" {
                        set.insert(f.fingerprint.clone());
                    }
                }
            }
            set
        })
    }

    /// Every fingerprint a user has CONVERTED to a task across all scans (optionally
    /// excluding `except_run`), mapped to the task id it was linked to. Carries
    /// convert-history forward so a re-discovered finding whose fingerprint was already
    /// converted stays `converted` + linked (when its task still lives, unfinished)
    /// instead of re-surfacing `open` and being re-minted on every re-scan. The caller
    /// checks task liveness/status; this only gathers the map. Mirrors `InsightStore`.
    pub fn converted_finding_fingerprints(&self, except_run: Option<&str>) -> HashMap<String, String> {
        self.read(|runs| {
            let mut map = HashMap::new();
            for run in runs.values() {
                if Some(run.id.as_str()) == except_run {
                    continue;
                }
                for f in &run.findings {
                    if f.status == "converted" {
                        if let Some(task_id) = &f.linked_task_id {
                            map.insert(f.fingerprint.clone(), task_id.clone());
                        }
                    }
                }
            }
            map
        })
    }

    /// Every fingerprint a user has DISMISSED a PROPOSAL under across all scans
    /// (optionally excluding `except_run`). Carries dismissed-history forward for
    /// task-shaped proposals — the proposal twin of [`dismissed_finding_fingerprints`].
    pub fn dismissed_proposal_fingerprints(&self, except_run: Option<&str>) -> HashSet<String> {
        self.read(|runs| {
            let mut set = HashSet::new();
            for run in runs.values() {
                if Some(run.id.as_str()) == except_run {
                    continue;
                }
                for p in &run.proposals {
                    if p.status == "dismissed" {
                        set.insert(p.fingerprint.clone());
                    }
                }
            }
            set
        })
    }

    /// Every fingerprint a user has CONVERTED a PROPOSAL to a task under across all scans
    /// (optionally excluding `except_run`), mapped to the task id. Carries convert-history
    /// forward so a re-discovered proposal whose fingerprint was already converted stays
    /// `converted` + linked (when its task still lives, unfinished) instead of re-surfacing
    /// and being re-minted. The proposal twin of [`converted_finding_fingerprints`].
    pub fn converted_proposal_fingerprints(
        &self,
        except_run: Option<&str>,
    ) -> HashMap<String, String> {
        self.read(|runs| {
            let mut map = HashMap::new();
            for run in runs.values() {
                if Some(run.id.as_str()) == except_run {
                    continue;
                }
                for p in &run.proposals {
                    if p.status == "converted" {
                        if let Some(task_id) = &p.linked_task_id {
                            map.insert(p.fingerprint.clone(), task_id.clone());
                        }
                    }
                }
            }
            map
        })
    }

    /// Prior artifact lifecycle states by fingerprint across all scans (optionally
    /// excluding `except_run`), so a re-scan carries `applied`/`dismissed` forward
    /// instead of re-proposing a harness piece the user already acted on. A fingerprint
    /// seen in multiple states resolves to the strongest signal: `applied` wins over
    /// `dismissed` wins over `proposed`. Returns `(status, applied_path, applied_at)` so
    /// the carry-forward preserves the original apply timestamp, not just the path.
    pub fn prior_artifact_states(
        &self,
        except_run: Option<&str>,
    ) -> HashMap<String, ArtifactCarry> {
        self.read(|runs| {
            let rank = |s: &str| match s {
                "applied" => 2,
                "dismissed" => 1,
                _ => 0,
            };
            let mut map: HashMap<String, ArtifactCarry> = HashMap::new();
            for run in runs.values() {
                if Some(run.id.as_str()) == except_run {
                    continue;
                }
                for a in &run.artifacts {
                    if a.status == "proposed" {
                        continue;
                    }
                    let carry = ArtifactCarry {
                        status: a.status.clone(),
                        applied_path: a.applied_path.clone(),
                        applied_at: a.applied_at,
                    };
                    match map.entry(a.fingerprint.clone()) {
                        std::collections::hash_map::Entry::Occupied(mut o) => {
                            if rank(&a.status) > rank(&o.get().status) {
                                o.insert(carry);
                            }
                        }
                        std::collections::hash_map::Entry::Vacant(v) => {
                            v.insert(carry);
                        }
                    }
                }
            }
            map
        })
    }
}

/// A prior artifact's carried-forward lifecycle for re-scan reconciliation.
pub struct ArtifactCarry {
    pub status: String,
    pub applied_path: Option<String>,
    pub applied_at: Option<u64>,
}
