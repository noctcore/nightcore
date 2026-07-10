//! Deterministic authoring (§3.4): grouping, ordering, counts, and provenance —
//! a PURE function of the loaded run's existing `category`/`severity`/`grade`/
//! coverage-`status` fields (decision 3). No `gh`, no engine, no clock: unit-testable
//! in isolation (the diff-budget "pure over parsed records" posture). `render.rs`
//! turns the resulting [`IssueMapPlan`] into markdown; the LLM pass only DECORATES it.

use std::collections::HashMap;

use super::contract::{GroupCount, SubIssuePreview};
use super::kind::ScanKind;
use crate::store::harness::{HarnessRun, StoredRuleCoverageGap};
use crate::store::insight::{FindingLocation, InsightRun};
use crate::store::scorecard::ScorecardRun;

/// The deterministic plan: the ordered groups of items over one run, from which the
/// parent title + counts + every sub-issue body are derived.
pub(crate) struct IssueMapPlan {
    pub kind: ScanKind,
    pub run_id: String,
    pub project_path: String,
    pub model: String,
    pub groups: Vec<PlanGroup>,
}

/// One ordered group (by category / dimension / coverage-status) + its ordered items.
pub(crate) struct PlanGroup {
    pub label: String,
    pub items: Vec<PlanItem>,
}

/// One grounded evidence anchor under an item (a `detail` and/or a `file:line`).
pub(crate) struct Evidence {
    pub detail: Option<String>,
    pub location: Option<String>,
}

/// The folded rule-coverage line for an Enforce convention (§3.4c).
pub(crate) struct Coverage {
    pub status: String,
    pub enforced_by: Vec<String>,
    pub documented_in: Vec<String>,
    pub suggested_artifact_kind: Option<String>,
}

/// One sub-issue's neutral, kind-agnostic render inputs (all text fields UNTRUSTED,
/// fenced/sanitized at render time). Absent sections are `None`/empty per kind.
pub(crate) struct PlanItem {
    pub title: String,
    /// `("Category","perf")` — label trusted (our own), value untrusted.
    pub meta: Vec<(&'static str, String)>,
    pub summary: Option<String>,
    pub location: Option<String>,
    pub coverage: Option<Coverage>,
    pub rationale: Option<String>,
    pub suggestion: Option<String>,
    pub evidence: Vec<Evidence>,
    pub code_before: Option<String>,
    pub code_after: Option<String>,
    pub affected_files: Vec<String>,
}

impl IssueMapPlan {
    /// Total exported items across all groups.
    pub(crate) fn total(&self) -> u32 {
        self.groups.iter().map(|g| g.items.len() as u32).sum()
    }

    /// The deterministic parent title (e.g. "Nightcore Insight map — 24 findings").
    pub(crate) fn parent_title(&self) -> String {
        let total = self.total();
        format!(
            "Nightcore {} map — {} {}",
            self.kind.display(),
            total,
            self.kind.noun(total)
        )
    }

    /// Per-group `{ label, count }` for the dialog chips + the counts table.
    pub(crate) fn group_counts(&self) -> Vec<GroupCount> {
        self.groups
            .iter()
            .map(|g| GroupCount {
                label: g.label.clone(),
                count: g.items.len() as u32,
            })
            .collect()
    }

    /// One preview row per item, in the deterministic order.
    pub(crate) fn sub_previews(&self) -> Vec<SubIssuePreview> {
        self.groups
            .iter()
            .flat_map(|g| {
                g.items.iter().map(|i| SubIssuePreview {
                    title: i.title.clone(),
                    group_label: g.label.clone(),
                })
            })
            .collect()
    }
}

// ─── Ordering ranks (smaller = comes first) ─────────────────────────────────────

fn severity_rank(s: &str) -> i32 {
    match s {
        "critical" => 0,
        "high" => 1,
        "medium" => 2,
        "low" => 3,
        _ => 4,
    }
}

fn effort_rank(s: &str) -> i32 {
    match s {
        "trivial" | "small" | "low" => 0,
        "medium" => 1,
        "large" | "high" => 2,
        _ => 3,
    }
}

/// Worst grade first: `F` = 0 … `A` = 5.
fn grade_rank(g: &str) -> i32 {
    match g {
        "F" => 0,
        "E" => 1,
        "D" => 2,
        "C" => 3,
        "B" => 4,
        "A" => 5,
        _ => 6,
    }
}

/// The gaps lead: `unenforced` = 0, `documented-only` = 1, `enforced` = 2.
fn status_rank(s: &str) -> i32 {
    match s {
        "unenforced" => 0,
        "documented-only" => 1,
        "enforced" => 2,
        _ => 3,
    }
}

/// The within-group ordering key. `.0` ALSO encodes the group-ordering dimension
/// (severity for Insight, grade for Scorecard, coverage-status for Enforce) so a
/// group's order rank is just the min `.0` across its members (see [`assemble`]).
type ItemKey = (i32, i32, String);

fn some_nonempty(s: &str) -> Option<String> {
    (!s.trim().is_empty()).then(|| s.to_string())
}

fn opt(o: &Option<String>) -> Option<String> {
    o.clone().filter(|s| !s.trim().is_empty())
}

/// Format a `FindingLocation` as `file:line` / `file:start-end` / `file`.
fn fmt_location(loc: &FindingLocation) -> String {
    let lines = match (loc.start_line, loc.end_line) {
        (Some(s), Some(e)) if e != s => format!(":{s}-{e}"),
        (Some(s), _) => format!(":{s}"),
        _ => String::new(),
    };
    format!("{}{}", loc.file, lines)
}

/// Group entries by label, order items within each group by [`ItemKey`], then order
/// the groups: primary = the min `ItemKey.0` in the group (worst severity/grade/
/// least-enforced first), secondary = `group_secondary(size)` (Insight orders larger
/// groups first via a negative size; the others pass 0), tertiary = the label (a
/// deterministic tie-break).
fn assemble(
    entries: Vec<(String, ItemKey, PlanItem)>,
    group_secondary: impl Fn(usize) -> i32,
) -> Vec<PlanGroup> {
    let mut map: HashMap<String, Vec<(ItemKey, PlanItem)>> = HashMap::new();
    for (label, key, item) in entries {
        map.entry(label).or_default().push((key, item));
    }
    let mut ranked: Vec<((i32, i32, String), PlanGroup)> = map
        .into_iter()
        .map(|(label, mut keyed)| {
            keyed.sort_by(|a, b| a.0.cmp(&b.0));
            let primary = keyed.iter().map(|(k, _)| k.0).min().unwrap_or(i32::MAX);
            let secondary = group_secondary(keyed.len());
            let items = keyed.into_iter().map(|(_, it)| it).collect();
            (
                (primary, secondary, label.clone()),
                PlanGroup { label, items },
            )
        })
        .collect();
    ranked.sort_by(|a, b| a.0.cmp(&b.0));
    ranked.into_iter().map(|(_, g)| g).collect()
}

// ─── Per-kind builders ──────────────────────────────────────────────────────────

/// Insight (§3.4a): group by `category`, groups ordered highest-severity-first then
/// larger-group-first; within a group severity high→low, tie-break effort then title.
/// Dismissed findings are excluded (open + converted export; dismissed is noise).
pub(crate) fn build_insight_plan(run: &InsightRun) -> IssueMapPlan {
    let entries = run
        .findings
        .iter()
        .filter(|f| f.status != "dismissed")
        .map(|f| {
            let key = (
                severity_rank(&f.severity),
                effort_rank(&f.effort),
                f.title.clone(),
            );
            let item = PlanItem {
                title: f.title.clone(),
                meta: vec![
                    ("Category", f.category.clone()),
                    ("Severity", f.severity.clone()),
                    ("Effort", f.effort.clone()),
                ],
                summary: some_nonempty(&f.description),
                location: f.location.as_ref().map(fmt_location),
                coverage: None,
                rationale: opt(&f.rationale),
                suggestion: opt(&f.suggestion),
                evidence: Vec::new(),
                code_before: opt(&f.code_before),
                code_after: opt(&f.code_after),
                affected_files: f.affected_files.clone(),
            };
            (f.category.clone(), key, item)
        })
        .collect();
    IssueMapPlan {
        kind: ScanKind::Insight,
        run_id: run.id.clone(),
        project_path: run.project_path.clone(),
        model: run.model.clone(),
        groups: assemble(entries, |n| -(n as i32)),
    }
}

/// Scorecard (§3.4b): group by `dimension`, groups ordered worst-grade-first; within
/// a group grade F→A, tie-break title.
pub(crate) fn build_scorecard_plan(run: &ScorecardRun) -> IssueMapPlan {
    let entries = run
        .readings
        .iter()
        .filter(|r| r.status != "dismissed")
        .map(|r| {
            let key = (grade_rank(&r.grade), 0, r.title.clone());
            let item = PlanItem {
                title: r.title.clone(),
                meta: vec![
                    ("Dimension", r.dimension.clone()),
                    ("Grade", r.grade.clone()),
                ],
                summary: some_nonempty(&r.summary),
                location: r.location.as_ref().map(fmt_location),
                coverage: None,
                rationale: opt(&r.rationale),
                suggestion: opt(&r.suggestion),
                evidence: r
                    .findings
                    .iter()
                    .map(|e| Evidence {
                        detail: some_nonempty(&e.detail),
                        location: e.location.as_ref().map(fmt_location),
                    })
                    .collect(),
                code_before: None,
                code_after: None,
                affected_files: r.affected_files.clone(),
            };
            (r.dimension.clone(), key, item)
        })
        .collect();
    IssueMapPlan {
        kind: ScanKind::Scorecard,
        run_id: run.id.clone(),
        project_path: run.project_path.clone(),
        model: run.model.clone(),
        groups: assemble(entries, |_| 0),
    }
}

/// Enforce (§3.4c): one sub-issue per convention finding; each folds in its coverage
/// (joined by `convention_fingerprint == fingerprint`) so coverage is NEVER a separate
/// sub-issue. Group by coverage `status` (unenforced → documented-only → enforced);
/// within a group severity high→low, tie-break title. A convention with no coverage
/// record defaults to `unenforced`; ORPHAN coverage (matches no exported finding) is
/// dropped (rare — recomputed each scan) so the sub-issue count == the convention
/// count and nothing is double-counted.
pub(crate) fn build_enforce_plan(run: &HarnessRun) -> IssueMapPlan {
    let coverage: HashMap<&str, &StoredRuleCoverageGap> = run
        .coverage
        .iter()
        .map(|c| (c.convention_fingerprint.as_str(), c))
        .collect();
    let entries = run
        .findings
        .iter()
        .filter(|f| f.status != "dismissed")
        .map(|f| {
            let cov = coverage.get(f.fingerprint.as_str()).copied();
            let status = cov
                .map(|c| c.status.clone())
                .unwrap_or_else(|| "unenforced".to_string());
            let key = (
                status_rank(&status),
                severity_rank(&f.severity),
                f.title.clone(),
            );
            let item = PlanItem {
                title: f.title.clone(),
                meta: vec![
                    ("Category", f.category.clone()),
                    ("Kind", f.kind.clone()),
                    ("Severity", f.severity.clone()),
                ],
                summary: some_nonempty(&f.description),
                location: None,
                coverage: cov.map(|c| Coverage {
                    status: c.status.clone(),
                    enforced_by: c.enforced_by.clone(),
                    documented_in: c.documented_in.clone(),
                    suggested_artifact_kind: opt(&c.suggested_artifact_kind),
                }),
                rationale: opt(&f.rationale),
                suggestion: opt(&f.suggestion),
                evidence: f
                    .evidence
                    .iter()
                    .map(|loc| Evidence {
                        detail: None,
                        location: Some(fmt_location(loc)),
                    })
                    .collect(),
                code_before: None,
                code_after: None,
                affected_files: Vec::new(),
            };
            (status, key, item)
        })
        .collect();
    IssueMapPlan {
        kind: ScanKind::Enforce,
        run_id: run.id.clone(),
        project_path: run.project_path.clone(),
        model: run.model.clone(),
        groups: assemble(entries, |_| 0),
    }
}
