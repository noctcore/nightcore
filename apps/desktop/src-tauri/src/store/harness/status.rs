//! Lifecycle mutation for findings/artifacts, plus the cross-run fingerprint
//! carry-forward (`dismissed_finding_fingerprints`, `prior_artifact_states`) that lets a
//! re-scan inherit the user's prior dismiss/apply edits instead of re-proposing them.

use std::collections::{HashMap, HashSet};

use super::store::HarnessStore;
use super::wire::HarnessRun;

/// The result of an atomic artifact-apply transition (see [`HarnessStore::mark_artifact_applied`]).
pub enum ApplyOutcome {
    /// The artifact was `proposed` and is now `applied` + records its written path.
    Applied,
    /// The artifact was ALREADY `applied` (idempotent re-apply) — the caller should
    /// NOT re-write the file; the existing applied path is returned.
    AlreadyApplied(String),
}

impl HarnessStore {
    /// Set a convention finding's status (`open` | `dismissed`), persisting the scan.
    /// Errors if the run OR the finding is unknown — a missing finding must not report
    /// phantom success.
    pub fn set_finding_status(
        &self,
        run_id: &str,
        finding_id: &str,
        status: &str,
    ) -> Result<HarnessRun, String> {
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        let mut run = guard
            .get(run_id)
            .cloned()
            .ok_or_else(|| format!("no harness run with id {run_id}"))?;
        let found = match run.findings.iter_mut().find(|f| f.id == finding_id) {
            Some(f) => {
                f.status = status.to_string();
                true
            }
            None => false,
        };
        if !found {
            return Err(format!("no finding {finding_id} in run {run_id}"));
        }
        run.updated_at = crate::task::now_ms();
        self.persist(&run)?;
        guard.insert(run.id.clone(), run.clone());
        Ok(run)
    }

    /// Set an artifact's status to `proposed` or `dismissed`, persisting the scan. Used by
    /// dismiss/restore; the `applied` transition goes through [`mark_artifact_applied`].
    pub fn set_artifact_status(
        &self,
        run_id: &str,
        artifact_id: &str,
        status: &str,
    ) -> Result<HarnessRun, String> {
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        let mut run = guard
            .get(run_id)
            .cloned()
            .ok_or_else(|| format!("no harness run with id {run_id}"))?;
        let found = match run.artifacts.iter_mut().find(|a| a.id == artifact_id) {
            Some(a) => {
                // Transitioning AWAY from `applied` (dismiss/restore of a written
                // artifact) must clear the applied metadata, else the record keeps a
                // dangling `applied_path`/`applied_at` and `prior_artifact_states` would
                // mis-rank a re-proposed artifact whose file is no longer tracked.
                if a.status == "applied" && status != "applied" {
                    a.applied_path = None;
                    a.applied_at = None;
                }
                a.status = status.to_string();
                true
            }
            None => false,
        };
        if !found {
            return Err(format!("no artifact {artifact_id} in run {run_id}"));
        }
        run.updated_at = crate::task::now_ms();
        self.persist(&run)?;
        guard.insert(run.id.clone(), run.clone());
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
        let mut guard = crate::sync::lock_or_recover(&self.runs);
        let mut run = guard
            .get(run_id)
            .cloned()
            .ok_or_else(|| format!("no harness run with id {run_id}"))?;
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
            return Ok((ApplyOutcome::AlreadyApplied(existing), run));
        }
        artifact.status = "applied".to_string();
        artifact.applied_path = Some(applied_path.to_string());
        artifact.applied_at = Some(crate::task::now_ms());
        run.updated_at = crate::task::now_ms();
        self.persist(&run)?;
        guard.insert(run.id.clone(), run.clone());
        Ok((ApplyOutcome::Applied, run))
    }

    /// Every fingerprint a user has DISMISSED across all scans (optionally excluding
    /// `except_run`). Carries dismissed-history forward for convention findings.
    pub fn dismissed_finding_fingerprints(&self, except_run: Option<&str>) -> HashSet<String> {
        let guard = crate::sync::lock_or_recover(&self.runs);
        let mut set = HashSet::new();
        for run in guard.values() {
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
        let guard = crate::sync::lock_or_recover(&self.runs);
        let rank = |s: &str| match s {
            "applied" => 2,
            "dismissed" => 1,
            _ => 0,
        };
        let mut map: HashMap<String, ArtifactCarry> = HashMap::new();
        for run in guard.values() {
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
    }
}

/// A prior artifact's carried-forward lifecycle for re-scan reconciliation.
pub struct ArtifactCarry {
    pub status: String,
    pub applied_path: Option<String>,
    pub applied_at: Option<u64>,
}
