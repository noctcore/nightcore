//! On-disk Harness scans (codebase convention auditor).
//!
//! One pretty-printed JSON file per run at
//! `<project>/.nightcore/harness/<runId>.json`, mirroring [`crate::store::insight::InsightStore`]:
//! an in-memory map behind a `Mutex` is the read source of truth, with
//! write-through to disk on every mutation. Project-scoped — activating a project
//! [`retarget`](HarnessStore::retarget)s the store at that project's `.nightcore/harness/`.
//!
//! Two lifecycles are owned here, not by the engine:
//! - convention findings: `open` | `dismissed` | `converted` (carried across re-runs by
//!   fingerprint; `converted` links the finding to the board task it was minted into),
//! - proposed artifacts: `proposed` | `applied` | `dismissed`. `applied` records the
//!   repo-relative path the artifact was written to and when. The actual file write
//!   lives in the sidecar command; this store only records the lifecycle transition,
//!   atomically, so a re-scan carries the applied/dismissed state forward by fingerprint
//!   instead of re-proposing harness pieces the user already acted on.

mod status;
mod store;
mod wire;

// Module facade: preserve the historical `crate::store::harness::*` paths after the
// god-file split so call sites elsewhere (`lib.rs` boot, `sidecar/harness.rs`,
// `store/project.rs`) keep resolving unchanged. Mirrors the glob-reexport pattern in
// `sidecar/mod.rs`.
pub use status::*;
pub use store::*;
pub use wire::*;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store() -> (HarnessStore, TempDir) {
        let tmp = TempDir::new().expect("temp dir");
        let store = HarnessStore::load_from(tmp.path().join("harness"));
        (store, tmp)
    }

    fn finding(id: &str, fp: &str) -> StoredConventionFinding {
        StoredConventionFinding {
            id: id.to_string(),
            category: "folder-structure".into(),
            kind: "convention".into(),
            severity: "medium".into(),
            title: "t".into(),
            description: "d".into(),
            rationale: None,
            evidence: vec![],
            suggestion: None,
            tags: vec![],
            confidence: None,
            fingerprint: fp.to_string(),
            status: "open".into(),
            linked_task_id: None,
        }
    }

    fn artifact(id: &str, fp: &str) -> StoredProposedArtifact {
        StoredProposedArtifact {
            id: id.to_string(),
            kind: "agent-contract".into(),
            group: None,
            group_title: None,
            title: "t".into(),
            description: "d".into(),
            rationale: None,
            target_path: "AGENTS.md".into(),
            write_mode: "merge-section".into(),
            content: "## Conventions\n".into(),
            language: Some("markdown".into()),
            source_findings: vec![],
            depends_on: vec![],
            confidence: None,
            fingerprint: fp.to_string(),
            status: "proposed".into(),
            applied_path: None,
            applied_at: None,
        }
    }

    fn run(id: &str) -> HarnessRun {
        HarnessRun {
            id: id.to_string(),
            project_path: "/proj".into(),
            status: "completed".into(),
            categories: vec!["folder-structure".into()],
            model: "claude-opus-4-8".into(),
            created_at: 1,
            updated_at: 1,
            cost_usd: 0.0,
            duration_ms: 0,
            usage: HarnessUsage::default(),
            profile: StoredRepoProfile::default(),
            findings: vec![finding("f1", "fp1")],
            rounds_by_category: std::collections::HashMap::new(),
            artifacts: vec![artifact("a1", "afp1")],
            proposals: vec![proposal("p1", "pfp1")],
            coverage: vec![coverage("fp1")],
            synthesizing: false,
            error: None,
        }
    }

    fn coverage(convention_fp: &str) -> StoredRuleCoverageGap {
        StoredRuleCoverageGap {
            id: format!("coverage-{convention_fp}"),
            convention_fingerprint: convention_fp.to_string(),
            category: "folder-structure".into(),
            title: "t".into(),
            status: "enforced".into(),
            enforced_by: vec!["noctcore-architecture/component-folder-structure".into()],
            documented_in: vec![],
            suggested_artifact_kind: Some("eslint-rule".into()),
            fingerprint: convention_fp.to_string(),
        }
    }

    fn proposal(id: &str, fp: &str) -> StoredHarnessProposal {
        StoredHarnessProposal {
            id: id.to_string(),
            kind: "apply-artifacts".into(),
            title: "t".into(),
            description: "d".into(),
            rationale: None,
            artifact_ids: vec!["a1".into()],
            prompt: None,
            verify_command: None,
            harness_check: None,
            confidence: None,
            fingerprint: fp.to_string(),
            status: "proposed".into(),
            linked_task_id: None,
        }
    }

    #[test]
    fn upsert_get_list_round_trip() {
        let (store, tmp) = store();
        store.upsert(&run("r1")).unwrap();
        assert_eq!(store.get("r1").unwrap().findings.len(), 1);
        assert_eq!(store.get("r1").unwrap().artifacts.len(), 1);
        assert_eq!(store.get("r1").unwrap().proposals.len(), 1);
        assert_eq!(store.list().len(), 1);
        let reloaded = HarnessStore::load_from(tmp.path().join("harness"));
        assert_eq!(reloaded.get("r1").unwrap().artifacts[0].fingerprint, "afp1");
        assert_eq!(reloaded.get("r1").unwrap().proposals[0].fingerprint, "pfp1");
    }

    #[test]
    fn record_category_round_updates_a_running_scan_but_noops_once_settled() {
        // Deep mode (issue #294): the reader's round arm records a per-lens round count
        // ONLY while the scan is running; a late round event after the terminal
        // `harness-scan-completed` must not touch a finalized scan (mirrors Insight).
        let (store, _tmp) = store();
        let mut r = run("live");
        r.status = "running".into();
        r.rounds_by_category.clear();
        store.upsert(&r).unwrap();

        store.record_category_round("live", "architecture", 3);
        assert_eq!(
            store
                .get("live")
                .unwrap()
                .rounds_by_category
                .get("architecture"),
            Some(&3)
        );
        // The next round overwrites (round N is 1-based, monotonic per lens).
        store.record_category_round("live", "architecture", 4);
        assert_eq!(
            store
                .get("live")
                .unwrap()
                .rounds_by_category
                .get("architecture"),
            Some(&4)
        );

        // A settled (completed) scan is a true no-op — the terminal event is authoritative.
        store.upsert(&run("done")).unwrap(); // the helper builds a `completed` run
        store.record_category_round("done", "architecture", 2);
        assert!(store.get("done").unwrap().rounds_by_category.is_empty());
    }

    #[test]
    fn a_pre_proposals_scan_on_disk_loads_with_an_empty_proposals_set() {
        // A HarnessRun JSON written before the `proposals` field existed must still
        // deserialize (serde default), proving the additive migration is zero-risk.
        let (_store, tmp) = store();
        let dir = tmp.path().join("harness");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = serde_json::json!({
            "id": "old",
            "projectPath": "/proj",
            "status": "completed",
            "categories": ["folder-structure"],
            "model": "claude-opus-4-8",
            "createdAt": 1,
            "updatedAt": 1,
            "findings": [],
            "artifacts": []
            // no `proposals` key
        });
        std::fs::write(
            dir.join("old.json"),
            serde_json::to_string_pretty(&legacy).unwrap(),
        )
        .unwrap();
        let reloaded = HarnessStore::load_from(dir);
        assert_eq!(reloaded.get("old").unwrap().proposals.len(), 0);
    }

    #[test]
    fn a_pre_coverage_scan_on_disk_loads_with_an_empty_coverage_set() {
        // A HarnessRun JSON written before the `coverage` field existed must still
        // deserialize (serde default), proving the additive ENFORCE-lite migration is
        // zero-risk — the sole persisted-shape touch in Phase 1.
        let (_store, tmp) = store();
        let dir = tmp.path().join("harness");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = serde_json::json!({
            "id": "old",
            "projectPath": "/proj",
            "status": "completed",
            "categories": ["folder-structure"],
            "model": "claude-opus-4-8",
            "createdAt": 1,
            "updatedAt": 1,
            "findings": [],
            "artifacts": [],
            "proposals": []
            // no `coverage` key
        });
        std::fs::write(
            dir.join("old.json"),
            serde_json::to_string_pretty(&legacy).unwrap(),
        )
        .unwrap();
        let reloaded = HarnessStore::load_from(dir);
        assert_eq!(reloaded.get("old").unwrap().coverage.len(), 0);
    }

    #[test]
    fn coverage_survives_the_disk_round_trip() {
        let (store, tmp) = store();
        store.upsert(&run("r1")).unwrap();
        let reloaded = HarnessStore::load_from(tmp.path().join("harness"));
        let cov = &reloaded.get("r1").unwrap().coverage;
        assert_eq!(cov.len(), 1);
        assert_eq!(cov[0].status, "enforced");
        assert_eq!(
            cov[0].enforced_by,
            vec!["noctcore-architecture/component-folder-structure"]
        );
        assert_eq!(cov[0].convention_fingerprint, "fp1");
    }

    #[test]
    fn stored_rule_coverage_gap_from_wire_parses() {
        let cv = serde_json::json!({
            "id": "coverage-fp",
            "conventionFingerprint": "fp",
            "category": "imports-boundaries",
            "title": "No cross-feature imports",
            "status": "documented-only",
            "enforcedBy": [],
            "documentedIn": ["No cross-feature imports."],
            "fingerprint": "fp"
        });
        let c = StoredRuleCoverageGap::from_wire(&cv).expect("parse coverage");
        assert_eq!(c.status, "documented-only");
        assert!(c.enforced_by.is_empty());
        assert_eq!(c.documented_in, vec!["No cross-feature imports."]);
        assert!(c.suggested_artifact_kind.is_none());
    }

    #[test]
    fn proposal_fingerprint_carry_forward_maps_across_runs() {
        let (store, _tmp) = store();
        let mut old = run("old");
        old.proposals[0].status = "converted".into();
        old.proposals[0].linked_task_id = Some("task-3".into());
        old.proposals[0].fingerprint = "shared-pfp".into();
        let mut old2 = run("old2");
        old2.proposals[0].status = "dismissed".into();
        old2.proposals[0].fingerprint = "gone-pfp".into();
        store.upsert(&old).unwrap();
        store.upsert(&old2).unwrap();
        store.upsert(&run("new")).unwrap();

        let converted = store.converted_proposal_fingerprints(Some("new"));
        assert_eq!(
            converted.get("shared-pfp").map(String::as_str),
            Some("task-3")
        );
        assert!(
            !converted.contains_key("pfp1"),
            "proposed proposals are not carried"
        );

        let dismissed = store.dismissed_proposal_fingerprints(Some("new"));
        assert!(dismissed.contains("gone-pfp"));
        assert!(!dismissed.contains("pfp1"));
    }

    #[test]
    fn link_proposal_task_converts_then_is_idempotent() {
        let (store, _tmp) = store();
        store.upsert(&run("r1")).unwrap();

        match store.link_proposal_task("r1", "p1", "task-4").unwrap() {
            LinkOutcome::Linked => {}
            LinkOutcome::AlreadyLinked(_) => panic!("first link should be Linked"),
        }
        let p = store.get_proposal("r1", "p1").unwrap();
        assert_eq!(p.status, "converted");
        assert_eq!(p.linked_task_id.as_deref(), Some("task-4"));

        // A second link (the losing race) returns the FIRST task id, no re-stamp.
        match store.link_proposal_task("r1", "p1", "task-44").unwrap() {
            LinkOutcome::AlreadyLinked(existing) => assert_eq!(existing, "task-4"),
            LinkOutcome::Linked => panic!("second link must be AlreadyLinked"),
        }
    }

    #[test]
    fn set_proposal_status_errors_on_missing() {
        let (store, _tmp) = store();
        store.upsert(&run("r1")).unwrap();
        assert!(store
            .set_proposal_status("r1", "ghost", "dismissed", None)
            .is_err());
        assert!(store
            .set_proposal_status("nope", "p1", "dismissed", None)
            .is_err());
    }

    #[test]
    fn dismiss_then_restore_proposal() {
        let (store, _tmp) = store();
        store.upsert(&run("r1")).unwrap();
        store
            .set_proposal_status("r1", "p1", "dismissed", None)
            .unwrap();
        assert_eq!(store.get_proposal("r1", "p1").unwrap().status, "dismissed");
        store
            .set_proposal_status("r1", "p1", "proposed", None)
            .unwrap();
        assert_eq!(store.get_proposal("r1", "p1").unwrap().status, "proposed");
    }

    #[test]
    fn from_wire_parses_a_proposal_with_a_suggested_check() {
        let pv = serde_json::json!({
            "id": "agent-task-abc",
            "kind": "agent-task",
            "title": "Wire the plugin",
            "description": "register + enable",
            "prompt": "add to eslint.config.ts",
            "verifyCommand": "npx eslint .",
            "harnessCheck": { "name": "folder", "kind": "lint-plugin", "command": "npx eslint ." },
            "artifactIds": [],
            "fingerprint": "pfp"
        });
        let p = StoredHarnessProposal::from_wire(&pv).expect("parse proposal");
        assert_eq!(p.kind, "agent-task");
        assert_eq!(p.verify_command.as_deref(), Some("npx eslint ."));
        assert_eq!(p.harness_check.unwrap().command, "npx eslint .");
        assert_eq!(p.status, "proposed");
        assert!(p.linked_task_id.is_none());
    }

    #[test]
    fn dismiss_finding_persists() {
        let (store, _tmp) = store();
        store.upsert(&run("r1")).unwrap();
        store
            .set_finding_status("r1", "f1", "dismissed", None)
            .unwrap();
        assert_eq!(
            store.get("r1").unwrap().findings[0].status,
            "dismissed".to_string()
        );
    }

    #[test]
    fn set_finding_status_errors_on_missing() {
        let (store, _tmp) = store();
        store.upsert(&run("r1")).unwrap();
        assert!(store
            .set_finding_status("r1", "ghost", "dismissed", None)
            .is_err());
        assert!(store
            .set_finding_status("nope", "f1", "dismissed", None)
            .is_err());
    }

    #[test]
    fn link_finding_task_converts_then_is_idempotent() {
        let (store, _tmp) = store();
        store.upsert(&run("r1")).unwrap();

        match store.link_finding_task("r1", "f1", "task-9").unwrap() {
            LinkOutcome::Linked => {}
            LinkOutcome::AlreadyLinked(_) => panic!("first link should be Linked"),
        }
        let f = store.get_finding("r1", "f1").unwrap();
        assert_eq!(f.status, "converted");
        assert_eq!(f.linked_task_id.as_deref(), Some("task-9"));

        // A second link (the losing race) returns the FIRST task id, no re-stamp.
        match store.link_finding_task("r1", "f1", "task-99").unwrap() {
            LinkOutcome::AlreadyLinked(existing) => assert_eq!(existing, "task-9"),
            LinkOutcome::Linked => panic!("second link must be AlreadyLinked"),
        }
        assert_eq!(
            store
                .get_finding("r1", "f1")
                .unwrap()
                .linked_task_id
                .as_deref(),
            Some("task-9")
        );
    }

    #[test]
    fn link_finding_task_errors_on_missing() {
        let (store, _tmp) = store();
        store.upsert(&run("r1")).unwrap();
        assert!(store.link_finding_task("r1", "ghost", "t").is_err());
        assert!(store.link_finding_task("nope", "f1", "t").is_err());
    }

    #[test]
    fn converted_finding_fingerprints_maps_fingerprint_to_task_across_runs() {
        let (store, _tmp) = store();
        let mut old = run("old");
        old.findings[0].status = "converted".into();
        old.findings[0].linked_task_id = Some("task-7".into());
        old.findings[0].fingerprint = "shared-fp".into();
        store.upsert(&old).unwrap();
        store.upsert(&run("new")).unwrap();

        let converted = store.converted_finding_fingerprints(Some("new"));
        assert_eq!(
            converted.get("shared-fp").map(String::as_str),
            Some("task-7")
        );
        assert!(
            !converted.contains_key("fp1"),
            "open findings are not carried"
        );
    }

    #[test]
    fn mark_artifact_applied_is_atomic_and_idempotent() {
        let (store, _tmp) = store();
        store.upsert(&run("r1")).unwrap();

        match store
            .mark_artifact_applied("r1", "a1", "AGENTS.md")
            .unwrap()
            .0
        {
            ApplyOutcome::Applied => {}
            ApplyOutcome::AlreadyApplied(_) => panic!("first apply should be Applied"),
        }
        let a = store.get_artifact("r1", "a1").unwrap();
        assert_eq!(a.status, "applied");
        assert_eq!(a.applied_path.as_deref(), Some("AGENTS.md"));
        assert!(a.applied_at.is_some());

        // A second apply (the losing race) returns the existing path, no re-write.
        match store
            .mark_artifact_applied("r1", "a1", "OTHER.md")
            .unwrap()
            .0
        {
            ApplyOutcome::AlreadyApplied(existing) => assert_eq!(existing, "AGENTS.md"),
            ApplyOutcome::Applied => panic!("second apply must be AlreadyApplied"),
        }
    }

    #[test]
    fn dismiss_then_restore_artifact() {
        let (store, _tmp) = store();
        store.upsert(&run("r1")).unwrap();
        store.set_artifact_status("r1", "a1", "dismissed").unwrap();
        assert_eq!(store.get_artifact("r1", "a1").unwrap().status, "dismissed");
        store.set_artifact_status("r1", "a1", "proposed").unwrap();
        assert_eq!(store.get_artifact("r1", "a1").unwrap().status, "proposed");
    }

    #[test]
    fn dismissed_finding_fingerprints_collects_across_runs() {
        let (store, _tmp) = store();
        let mut old = run("old");
        old.findings[0].status = "dismissed".into();
        old.findings[0].fingerprint = "shared-fp".into();
        store.upsert(&old).unwrap();
        store.upsert(&run("new")).unwrap();

        let dismissed = store.dismissed_finding_fingerprints(Some("new"));
        assert!(dismissed.contains("shared-fp"));
        assert!(!dismissed.contains("fp1"));
    }

    #[test]
    fn prior_artifact_states_carries_applied_forward() {
        let (store, _tmp) = store();
        let mut old = run("old");
        old.artifacts[0].status = "applied".into();
        old.artifacts[0].applied_path = Some("AGENTS.md".into());
        old.artifacts[0].applied_at = Some(123_456);
        old.artifacts[0].fingerprint = "shared-afp".into();
        store.upsert(&old).unwrap();

        let prior = store.prior_artifact_states(None);
        let carry = prior.get("shared-afp").expect("present");
        assert_eq!(carry.status, "applied");
        assert_eq!(carry.applied_path.as_deref(), Some("AGENTS.md"));
        assert_eq!(
            carry.applied_at,
            Some(123_456),
            "apply timestamp carries forward"
        );
    }

    #[test]
    fn dismissing_an_applied_artifact_clears_applied_metadata() {
        // Transitioning away from `applied` must drop the dangling applied_path/applied_at
        // so a re-proposed artifact isn't mis-ranked as still-on-disk.
        let (store, _tmp) = store();
        let mut r = run("r1");
        r.artifacts[0].status = "applied".into();
        r.artifacts[0].applied_path = Some("AGENTS.md".into());
        r.artifacts[0].applied_at = Some(999);
        store.upsert(&r).unwrap();

        store.set_artifact_status("r1", "a1", "dismissed").unwrap();
        let a = store.get_artifact("r1", "a1").unwrap();
        assert_eq!(a.status, "dismissed");
        assert!(a.applied_path.is_none(), "applied_path cleared");
        assert!(a.applied_at.is_none(), "applied_at cleared");
    }

    #[test]
    fn reap_running_marks_running_failed() {
        let (store, _tmp) = store();
        let mut r = run("r1");
        r.status = "running".into();
        store.upsert(&r).unwrap();
        store.reap_running();
        assert_eq!(store.get("r1").unwrap().status, "failed");
        assert!(store.get("r1").unwrap().error.is_some());
    }

    #[test]
    fn accumulate_findings_persists_mid_scan_and_is_noop_once_completed() {
        let (store, _tmp) = store();
        // A fresh running scan with no findings yet (the helper `run` seeds one, so
        // build an empty running scan explicitly).
        let mut r = run("r1");
        r.status = "running".into();
        r.findings = vec![];
        r.artifacts = vec![];
        r.cost_usd = 0.0;
        r.usage = HarnessUsage::default();
        store.upsert(&r).unwrap();

        let empty = std::collections::HashSet::new();
        store
            .accumulate_findings("r1", vec![finding("f1", "fp1")], &empty, 0.7, 8, 4)
            .unwrap();
        let got = store.get("r1").unwrap();
        assert_eq!(
            got.findings.len(),
            1,
            "the lens's finding is persisted mid-scan"
        );
        assert_eq!(got.cost_usd, 0.7);
        assert_eq!(got.usage.input_tokens, 8);

        // Re-delivery of the same id is idempotent.
        store
            .accumulate_findings("r1", vec![finding("f1", "fp1")], &empty, 0.0, 0, 0)
            .unwrap();
        assert_eq!(store.get("r1").unwrap().findings.len(), 1);

        // A prior-run dismissed fingerprint carries forward onto a fresh finding.
        let mut dismissed = std::collections::HashSet::new();
        dismissed.insert("fp2".to_string());
        store
            .accumulate_findings("r1", vec![finding("f2", "fp2")], &dismissed, 0.0, 0, 0)
            .unwrap();
        let got = store.get("r1").unwrap();
        let f2 = got.findings.iter().find(|f| f.id == "f2").unwrap();
        assert_eq!(f2.status, "dismissed");

        // A completed scan is authoritative — no incremental accumulation.
        store
            .accumulate_findings("r1", vec![finding("f3", "fp3")], &empty, 0.0, 0, 0)
            .unwrap();
        store
            .mutate("r1", |run| run.status = "completed".into())
            .unwrap();
        store
            .accumulate_findings("r1", vec![finding("f9", "fp9")], &empty, 5.0, 0, 0)
            .unwrap();
        let got = store.get("r1").unwrap();
        assert!(
            got.findings.iter().all(|f| f.id != "f9"),
            "no incremental write once the scan is completed"
        );
    }

    #[test]
    fn from_wire_parses_finding_and_artifact() {
        let fv = serde_json::json!({
            "id": "folder-structure-abc",
            "category": "folder-structure",
            "kind": "convention",
            "severity": "medium",
            "title": "Folder per component",
            "description": "colocated siblings",
            "evidence": [{ "file": "apps/web/src/x.tsx", "startLine": 1 }],
            "tags": ["folder-per-component"],
            "fingerprint": "fp"
        });
        let f = StoredConventionFinding::from_wire(&fv).expect("parse finding");
        assert_eq!(f.kind, "convention");
        assert_eq!(f.evidence[0].start_line, Some(1));
        assert_eq!(f.status, "open");

        let av = serde_json::json!({
            "id": "pa-1",
            "kind": "agent-contract",
            "title": "Codify in AGENTS.md",
            "description": "managed section",
            "targetPath": "AGENTS.md",
            "writeMode": "merge-section",
            "content": "## Conventions\n",
            "sourceFindings": ["fp"],
            "fingerprint": "afp"
        });
        let a = StoredProposedArtifact::from_wire(&av).expect("parse artifact");
        assert_eq!(a.kind, "agent-contract");
        assert_eq!(a.target_path, "AGENTS.md");
        assert_eq!(a.status, "proposed");
        assert!(a.applied_path.is_none());
    }
}
