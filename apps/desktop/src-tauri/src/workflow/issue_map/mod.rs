//! Issue-map export (wayfinder #112) — a READ-ONLY projection of an already-completed
//! scan onto GitHub: one parent "map" issue + one native sub-issue per finding.
//!
//! An AGGREGATION + RENDERING + POSTING flow over instrumentation that already exists:
//! it reads a persisted `completed` scan run VERBATIM off its store (Insight /
//! Scorecard / the Enforce-conventions half of Harness), groups/orders/counts it
//! DETERMINISTICALLY (`plan`), decorates it with ONE fail-open `claude -p` pass
//! (`narrative`), renders it GitHub-safe (`render`, over the shared
//! `workflow::github_md` fences), and posts it via the `gh` seam (`post`). ZERO new
//! persistence in `.nightcore/`, zero scan-shape change, zero new mint prefix — fully
//! orthogonal to convert-to-task. The prior map is re-discovered by label (§3.10),
//! never stored.
//!
//! A peer of `workflow/issue_triage/`, `workflow/trust/`, `workflow/pr/`. The thin
//! async `#[tauri::command]`s live in `sidecar/issue_map.rs`; this tier is the
//! headless-testable core.

mod contract;
mod kind;
mod narrative;
mod plan;
mod post;
mod render;

#[cfg(test)]
mod tests;
#[cfg(test)]
pub(crate) mod tests_support;

pub(crate) use contract::{GroupCount, IssueMapPreview, IssueMapResult, Narrative};
// The nested preview shapes are named ONLY by the ts-rs export aggregator
// (`bindings/export.rs`, `#[cfg(test)]`) — `export_all::<IssueMapPreview>()` writes
// them transitively, so the runtime crate never names them (the `trust::mod`
// precedent). Re-exported test-only so a release build carries no unused re-export.
#[cfg(test)]
pub(crate) use contract::{GroupIntro, PriorMap, SubIssuePreview};
pub(crate) use kind::ScanKind;
pub(crate) use narrative::generate;
pub(crate) use plan::{build_enforce_plan, build_insight_plan, build_scorecard_plan, IssueMapPlan};
pub(crate) use post::{export_map, find_prior_map, GH_TIMEOUT};
pub(crate) use render::{format_utc_datetime, render_parent_body};
