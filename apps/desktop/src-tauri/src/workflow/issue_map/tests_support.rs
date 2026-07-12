//! Shared synthetic-run builders for the issue-map tests (plan / render /
//! narrative / post / preview==post). Clones the store test builders
//! (`store::insight`, `store::scorecard`, `store::harness`) so every test tier
//! grounds on the same realistic shapes. Test-only.

use crate::store::harness::{
    HarnessRun, HarnessUsage, StoredConventionFinding, StoredRuleCoverageGap,
};
use crate::store::insight::{FindingLocation, InsightRun, InsightUsage, StoredFinding};
use crate::store::scorecard::{ScorecardEvidence, ScorecardRun, StoredReading};

fn loc(file: &str, start: u64, end: u64) -> FindingLocation {
    FindingLocation {
        file: file.into(),
        start_line: Some(start),
        end_line: Some(end),
        symbol: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn finding(
    id: &str,
    category: &str,
    severity: &str,
    effort: &str,
    title: &str,
    fp: &str,
    status: &str,
) -> StoredFinding {
    StoredFinding {
        id: id.into(),
        category: category.into(),
        severity: severity.into(),
        effort: effort.into(),
        title: title.into(),
        description: format!("Description of {title}."),
        rationale: Some(format!("Why {title} matters.")),
        location: Some(loc("src/a.ts", 10, 12)),
        suggestion: Some(format!("Fix {title}.")),
        code_before: None,
        code_after: None,
        affected_files: vec!["src/a.ts".into()],
        tags: vec![],
        confidence: None,
        fingerprint: fp.into(),
        status: status.into(),
        linked_task_id: None,
    }
}

/// An Insight run: `bugs` (high, medium) + `perf` (low) exported, one dismissed
/// `security` finding excluded. `f1` carries a code diff to exercise that section.
pub(crate) fn insight_run() -> InsightRun {
    let mut f1 = finding("f1", "bugs", "high", "small", "Null deref", "fp1", "open");
    f1.code_before = Some("a.b".into());
    f1.code_after = Some("a?.b".into());
    InsightRun {
        id: "run-insight".into(),
        project_path: "/proj".into(),
        scope: "repo".into(),
        status: "completed".into(),
        categories: vec!["bugs".into(), "perf".into()],
        model: "claude-opus-4-8".into(),
        created_at: 1_609_459_200_000, // 2021-01-01T00:00:00Z
        updated_at: 1_609_459_200_000,
        cost_usd: 0.0,
        duration_ms: 0,
        usage: InsightUsage::default(),
        findings: vec![
            f1,
            finding(
                "f2",
                "bugs",
                "medium",
                "medium",
                "Off by one",
                "fp2",
                "open",
            ),
            finding("f3", "perf", "low", "large", "N+1 query", "fp3", "open"),
            finding(
                "f4",
                "security",
                "high",
                "small",
                "Dismissed hole",
                "fp4",
                "dismissed",
            ),
        ],
        rounds_by_category: std::collections::HashMap::new(),
        error: None,
    }
}

fn reading(id: &str, dimension: &str, grade: &str, title: &str, fp: &str) -> StoredReading {
    StoredReading {
        id: id.into(),
        dimension: dimension.into(),
        grade: grade.into(),
        title: title.into(),
        summary: format!("Summary of {title}."),
        rationale: Some(format!("Rationale for {title}.")),
        location: Some(loc("src/b.ts", 5, 5)),
        suggestion: Some(format!("Improve {title}.")),
        affected_files: vec!["src/b.ts".into()],
        tags: vec![],
        findings: vec![ScorecardEvidence {
            detail: format!("Evidence for {title}."),
            location: Some(loc("src/b.ts", 7, 7)),
        }],
        confidence: None,
        fingerprint: fp.into(),
        status: "open".into(),
        linked_task_id: None,
    }
}

/// A Scorecard run: `security` (F, C) + `maintainability` (B). Worst grade (F) leads.
pub(crate) fn scorecard_run() -> ScorecardRun {
    ScorecardRun {
        id: "run-scorecard".into(),
        project_path: "/proj".into(),
        status: "completed".into(),
        dimensions: vec!["security".into(), "maintainability".into()],
        model: "claude-opus-4-8".into(),
        created_at: 1_609_459_200_000,
        updated_at: 1_609_459_200_000,
        cost_usd: 0.0,
        duration_ms: 0,
        usage: InsightUsage::default(),
        readings: vec![
            reading("r1", "security", "F", "No auth on admin routes", "sfp1"),
            reading("r2", "security", "C", "Weak password hashing", "sfp2"),
            reading("r3", "maintainability", "B", "Long files", "sfp3"),
        ],
        error: None,
    }
}

fn convention(
    id: &str,
    category: &str,
    severity: &str,
    title: &str,
    fp: &str,
    status: &str,
) -> StoredConventionFinding {
    StoredConventionFinding {
        id: id.into(),
        category: category.into(),
        kind: "convention".into(),
        severity: severity.into(),
        title: title.into(),
        description: format!("Convention: {title}."),
        rationale: Some(format!("Rationale for {title}.")),
        evidence: vec![loc("src/c.ts", 3, 4)],
        suggestion: Some(format!("Adopt {title}.")),
        tags: vec![],
        confidence: None,
        fingerprint: fp.into(),
        status: status.into(),
        linked_task_id: None,
    }
}

fn coverage(convention_fp: &str, status: &str, enforced_by: Vec<&str>) -> StoredRuleCoverageGap {
    StoredRuleCoverageGap {
        id: format!("cov-{convention_fp}"),
        convention_fingerprint: convention_fp.into(),
        category: "folder-structure".into(),
        title: "coverage".into(),
        status: status.into(),
        enforced_by: enforced_by.into_iter().map(String::from).collect(),
        documented_in: vec![],
        suggested_artifact_kind: Some("eslint-rule".into()),
        fingerprint: format!("covfp-{convention_fp}"),
    }
}

/// An Enforce/Harness run: `fp1` enforced + `fp2` unenforced exported, a dismissed
/// `fp3` excluded, and an ORPHAN coverage record (matches no finding) that must drop.
pub(crate) fn harness_run() -> HarnessRun {
    HarnessRun {
        id: "run-harness".into(),
        project_path: "/proj".into(),
        status: "completed".into(),
        categories: vec!["folder-structure".into()],
        model: "claude-opus-4-8".into(),
        created_at: 1_609_459_200_000,
        updated_at: 1_609_459_200_000,
        cost_usd: 0.0,
        duration_ms: 0,
        usage: HarnessUsage::default(),
        profile: Default::default(),
        findings: vec![
            convention(
                "c1",
                "folder-structure",
                "medium",
                "Folder per component",
                "fp1",
                "open",
            ),
            convention("c2", "imports", "high", "Sorted imports", "fp2", "open"),
            convention(
                "c3",
                "naming",
                "low",
                "Zod schema naming",
                "fp3",
                "dismissed",
            ),
        ],
        rounds_by_category: std::collections::HashMap::new(),
        artifacts: vec![],
        proposals: vec![],
        coverage: vec![
            coverage(
                "fp1",
                "enforced",
                vec!["nightcore/component-folder-structure"],
            ),
            coverage("fp2", "unenforced", vec![]),
            coverage("fp-orphan", "documented-only", vec![]),
        ],
        synthesizing: false,
        error: None,
    }
}
