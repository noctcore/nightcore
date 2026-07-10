//! Plan (deterministic grouping/ordering/counts), renderer (golden-ish), and the
//! preview==post determinism guarantee. The `gh`/label/narrative tiers are tested in
//! their own modules.

use super::contract::{Narrative, PriorMap};
use super::kind::ScanKind;
use super::plan::{
    build_enforce_plan, build_insight_plan, build_scorecard_plan, Coverage, Evidence, PlanItem,
};
use super::render::{format_utc_datetime, render_parent_body, render_sub_issue_body};
use super::tests_support::{harness_run, insight_run, scorecard_run};

fn narrative() -> Narrative {
    Narrative {
        exec_summary: "A concise executive summary.".into(),
        group_intros: vec![],
    }
}

// ─── Plan (§8.1) ────────────────────────────────────────────────────────────────

#[test]
fn insight_groups_by_category_ordered_severity_first() {
    let plan = build_insight_plan(&insight_run());
    assert_eq!(
        plan.total(),
        3,
        "the dismissed security finding is excluded"
    );
    assert_eq!(plan.groups[0].label, "bugs", "highest-severity group leads");
    assert_eq!(
        plan.groups[0].items[0].title, "Null deref",
        "high severity before medium within the group"
    );
    assert_eq!(plan.groups[0].items[1].title, "Off by one");
    assert_eq!(plan.groups[1].label, "perf");
    assert!(
        plan.groups.iter().all(|g| g.label != "security"),
        "a group with only dismissed findings never appears"
    );
    // Counts match the exported items.
    let counted: u32 = plan.group_counts().iter().map(|g| g.count).sum();
    assert_eq!(counted, plan.total());
}

#[test]
fn scorecard_groups_by_dimension_ordered_worst_grade_first() {
    let plan = build_scorecard_plan(&scorecard_run());
    assert_eq!(
        plan.groups[0].label, "security",
        "worst-grade (F) group leads"
    );
    assert_eq!(
        plan.groups[0].items[0].title, "No auth on admin routes",
        "grade F before C within the dimension"
    );
    assert_eq!(plan.groups[1].label, "maintainability");
    assert_eq!(plan.total(), 3);
}

#[test]
fn enforce_folds_coverage_into_the_matching_convention_and_never_double_counts() {
    let plan = build_enforce_plan(&harness_run());
    // Two exported conventions (fp3 dismissed); the orphan coverage is dropped.
    assert_eq!(
        plan.total(),
        2,
        "sub-issue count == convention count (no orphan)"
    );
    assert_eq!(plan.groups[0].label, "unenforced", "the gaps lead");
    assert_eq!(plan.groups[0].items[0].title, "Sorted imports");
    assert_eq!(plan.groups[1].label, "enforced");
    let enforced_item = &plan.groups[1].items[0];
    assert_eq!(enforced_item.title, "Folder per component");
    let cov = enforced_item
        .coverage
        .as_ref()
        .expect("coverage folded into the convention");
    assert_eq!(cov.status, "enforced");
    assert!(
        cov.enforced_by
            .iter()
            .any(|r| r == "nightcore/component-folder-structure"),
        "the folded coverage carries the enforcing rule id"
    );
    assert!(
        plan.groups.iter().all(|g| g.label != "documented-only"),
        "the orphan coverage record did not create its own group/sub-issue"
    );
}

// ─── Renderer (§8.2) ────────────────────────────────────────────────────────────

#[test]
fn sub_issue_body_carries_title_location_and_provenance() {
    let plan = build_insight_plan(&insight_run());
    let item = &plan.groups[0].items[0]; // "Null deref" — has a location + code diff
    let body = render_sub_issue_body(ScanKind::Insight, "run-insight", item);
    assert!(
        body.contains("### 🌙 Nightcore — Insight finding"),
        "house header"
    );
    assert!(body.contains("Null deref"), "the title appears in the body");
    assert!(body.contains("`src/a.ts:10-12`"), "location as a code span");
    assert!(
        body.contains("**Before**") && body.contains("**After**"),
        "code diff"
    );
    assert!(
        body.contains("_From Nightcore Insight run `run-insight`._"),
        "provenance footer with the runId"
    );
}

#[test]
fn a_hostile_title_is_neutralized_into_one_safe_code_span() {
    let item = PlanItem {
        title: "evil``` ```\nrm -rf /".into(),
        meta: vec![],
        summary: None,
        location: None,
        coverage: None,
        rationale: None,
        suggestion: None,
        evidence: vec![],
        code_before: None,
        code_after: None,
        affected_files: vec![],
    };
    let body = render_sub_issue_body(ScanKind::Insight, "r", &item);
    assert!(
        !body.contains("evil``` ```\nrm"),
        "the newline + fence in the title are collapsed, not passed through raw"
    );
    // The `**Finding:**` span fences the (sanitized, one-line) title safely.
    let line = body
        .lines()
        .find(|l| l.starts_with("**Finding:**"))
        .expect("finding line");
    assert!(
        line.contains("rm -rf /"),
        "the content survives (bounded, not censored)"
    );
    assert!(!line.contains('\n'), "no injected line break");
}

#[test]
fn enforce_body_renders_the_folded_coverage_line() {
    let item = PlanItem {
        title: "Sorted imports".into(),
        meta: vec![
            ("Category", "imports".into()),
            ("Kind", "convention".into()),
        ],
        summary: Some("Imports must be sorted.".into()),
        location: None,
        coverage: Some(Coverage {
            status: "unenforced".into(),
            enforced_by: vec![],
            documented_in: vec![],
            suggested_artifact_kind: Some("eslint-rule".into()),
        }),
        rationale: None,
        suggestion: None,
        evidence: vec![Evidence {
            detail: None,
            location: Some("src/c.ts:3-4".into()),
        }],
        code_before: None,
        code_after: None,
        affected_files: vec![],
    };
    let body = render_sub_issue_body(ScanKind::Enforce, "run-harness", &item);
    assert!(
        body.contains("**Coverage:** status unenforced"),
        "coverage line"
    );
    assert!(
        body.contains("suggested artifact `eslint-rule`"),
        "suggested artifact"
    );
    assert!(
        body.contains("**Evidence:**") && body.contains("`src/c.ts:3-4`"),
        "evidence anchor"
    );
}

#[test]
fn parent_body_carries_kind_runid_timestamp_counts_and_supersede() {
    let plan = build_insight_plan(&insight_run());
    let prior = PriorMap {
        number: 9,
        title: "Old map".into(),
        url: "https://h/9".into(),
    };
    let body = render_parent_body(
        &plan,
        &narrative(),
        "2021-01-01T00:00:00Z",
        Some(&prior),
        None,
    );
    assert!(
        body.contains("### 🌙 Nightcore — Insight map"),
        "house header"
    );
    assert!(
        body.contains("A concise executive summary."),
        "narrative summary"
    );
    assert!(body.contains("**Scan** insight"), "kind in provenance");
    assert!(body.contains("`run-insight`"), "runId code span");
    assert!(body.contains("2021-01-01T00:00:00Z"), "ISO timestamp");
    assert!(body.contains("- **Total:** 3"), "counts table");
    assert!(
        body.contains("_Supersedes #9._"),
        "supersede line when a prior map is passed"
    );
    assert!(body.contains("_Posted from Nightcore._"), "footer");
}

#[test]
fn parent_body_omits_supersede_when_none() {
    let plan = build_insight_plan(&insight_run());
    let body = render_parent_body(&plan, &narrative(), "2021-01-01T00:00:00Z", None, None);
    assert!(
        !body.contains("Supersedes"),
        "no supersede line without a prior map"
    );
}

#[test]
fn degraded_checklist_appends_child_task_list() {
    let plan = build_insight_plan(&insight_run());
    let children = vec![
        (11u64, "Null deref".to_string()),
        (12u64, "Off by one".to_string()),
    ];
    let body = render_parent_body(
        &plan,
        &narrative(),
        "2021-01-01T00:00:00Z",
        None,
        Some(&children),
    );
    assert!(
        body.contains("## Sub-issues"),
        "checklist section under degradation"
    );
    assert!(
        body.contains("- [ ] #11 `Null deref`"),
        "a task-list child entry"
    );
}

#[test]
fn format_utc_datetime_is_iso8601() {
    assert_eq!(
        format_utc_datetime(1_609_459_200_000),
        "2021-01-01T00:00:00Z"
    );
    assert_eq!(
        format_utc_datetime(1_609_462_861_000),
        "2021-01-01T01:01:01Z"
    );
    assert_eq!(format_utc_datetime(0), "1970-01-01T00:00:00Z");
}

// ─── preview == post (§8.7) ─────────────────────────────────────────────────────

#[test]
fn parent_body_is_byte_identical_for_the_same_run_narrative_and_timestamp() {
    let plan = build_insight_plan(&insight_run());
    let n = narrative();
    let a = render_parent_body(&plan, &n, "2021-01-01T00:00:00Z", None, None);
    let b = render_parent_body(&plan, &n, "2021-01-01T00:00:00Z", None, None);
    assert_eq!(
        a, b,
        "the preview body and the re-derived post body match byte-for-byte"
    );
}

#[test]
fn sub_issue_body_is_deterministic() {
    let plan = build_insight_plan(&insight_run());
    let item = &plan.groups[0].items[0];
    let a = render_sub_issue_body(ScanKind::Insight, "run-insight", item);
    let b = render_sub_issue_body(ScanKind::Insight, "run-insight", item);
    assert_eq!(a, b);
}
