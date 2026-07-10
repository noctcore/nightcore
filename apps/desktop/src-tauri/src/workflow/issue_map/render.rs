//! The ONE markdown renderer for a map: the parent body (exec summary + group
//! intros + counts + provenance + supersede line, plus the degraded task-list
//! checklist) and each sub-issue body. UNTRUSTED spans go through the shared
//! `code_span`/`code_block`; prose through `prose`; our own labels/counts are
//! trusted. The prompt-only `untrusted_block` is NEVER used on a GitHub body (§3.6).
//!
//! Determinism (preview == post, §3.8): every input is deterministic given the run +
//! narrative + `generated_at`. The narrative is re-sanitized here (idempotent), so
//! whether it arrives fresh from the preview or handed back to the write command, the
//! bytes are identical — and a tampered narrative is still neutralized.

use super::contract::{Narrative, PriorMap};
use super::kind::ScanKind;
use super::plan::{Coverage, Evidence, IssueMapPlan, PlanItem};
use crate::workflow::github_md::{cap_body, code_block, code_span, one_line, prose};

/// GitHub's issue-body limit is 64K; cap a runaway body well under it.
const BODY_CAP: usize = 60_000;
const FOOTER: &str = "_Posted from Nightcore._";

/// Format epoch-ms as an ISO-8601 UTC `YYYY-MM-DDTHH:MM:SSZ` timestamp (Howard
/// Hinnant's civil-from-days, extending the date-only `issue_triage::format_utc_date`
/// with a time component). Pure so the provenance line stays deterministic.
pub(crate) fn format_utc_datetime(epoch_ms: u64) -> String {
    let secs = (epoch_ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (h, m, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mon = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mon <= 2 { y + 1 } else { y };
    format!("{y:04}-{mon:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Render the parent map body. `checklist` is `None` on the happy (native sub-issue)
/// path + in the preview — so the preview bytes match the post; it is `Some(children)`
/// ONLY under linkage degradation (§3.2.2), where the parent is created LAST with the
/// task-list baked in.
pub(crate) fn render_parent_body(
    plan: &IssueMapPlan,
    narrative: &Narrative,
    generated_at: &str,
    supersedes: Option<&PriorMap>,
    checklist: Option<&[(u64, String)]>,
) -> String {
    let mut out = format!("### 🌙 Nightcore — {} map\n\n", plan.kind.display());
    out.push_str(&prose(&narrative.exec_summary));
    out.push_str("\n\n## Groups\n");
    for group in &plan.groups {
        out.push_str(&format!(
            "\n### {} ({})\n",
            one_line(&group.label),
            group.items.len()
        ));
        if let Some(intro) = narrative.intro_for(&group.label) {
            out.push_str(&prose(intro));
            out.push('\n');
        }
    }

    out.push_str("\n## Summary\n");
    out.push_str(&format!("- **Total:** {}\n", plan.total()));
    for group in &plan.groups {
        out.push_str(&format!(
            "- **{}:** {}\n",
            one_line(&group.label),
            group.items.len()
        ));
    }

    if let Some(children) = checklist {
        out.push_str("\n## Sub-issues\n");
        for (number, title) in children {
            out.push_str(&format!("- [ ] #{number} {}\n", code_span(title)));
        }
    }

    out.push_str("\n---\n");
    out.push_str(&format!(
        "**Scan** {} · **Run** {} · **Generated** {} · **Model** {}\n",
        plan.kind.wire(),
        code_span(&plan.run_id),
        generated_at,
        code_span(&plan.model),
    ));
    if let Some(prior) = supersedes {
        out.push_str(&format!("\n_Supersedes #{}._\n", prior.number));
    }
    out.push_str(&format!("\n{FOOTER}\n"));
    cap_body(out, BODY_CAP)
}

/// Render one sub-issue body (§3.4/§6): the finding's fields, GitHub-safe, ending in a
/// provenance footer. Absent sections are skipped.
pub(crate) fn render_sub_issue_body(kind: ScanKind, run_id: &str, item: &PlanItem) -> String {
    let mut out = format!("### 🌙 Nightcore — {} finding\n\n", kind.display());
    out.push_str(&format!("**Finding:** {}\n", code_span(&item.title)));

    if let Some(summary) = &item.summary {
        out.push_str(&format!("\n{}\n", prose(summary)));
    }

    if !item.meta.is_empty() {
        let meta: Vec<String> = item
            .meta
            .iter()
            .map(|(label, value)| format!("**{label}:** {}", code_span(value)))
            .collect();
        out.push_str(&format!("\n{}\n", meta.join(" · ")));
    }

    if let Some(location) = &item.location {
        out.push_str(&format!("\n**Location:** {}\n", code_span(location)));
    }

    if let Some(coverage) = &item.coverage {
        out.push_str(&render_coverage(coverage));
    }

    if let Some(rationale) = &item.rationale {
        out.push_str(&format!("\n**Why it matters:** {}\n", prose(rationale)));
    }

    if let Some(suggestion) = &item.suggestion {
        out.push_str(&format!("\n**Suggested fix:** {}\n", prose(suggestion)));
    }

    if !item.evidence.is_empty() {
        out.push_str("\n**Evidence:**\n");
        for e in &item.evidence {
            out.push_str(&render_evidence(e));
        }
    }

    if let (Some(before), Some(after)) = (&item.code_before, &item.code_after) {
        out.push_str(&format!(
            "\n**Before**\n{}\n\n**After**\n{}\n",
            code_block(before),
            code_block(after)
        ));
    }

    if !item.affected_files.is_empty() {
        let files: Vec<String> = item.affected_files.iter().map(|f| code_span(f)).collect();
        out.push_str(&format!("\n**Affected files:** {}\n", files.join(", ")));
    }

    out.push_str(&format!(
        "\n---\n_From Nightcore {} run {}._\n",
        kind.display(),
        code_span(run_id)
    ));
    cap_body(out, BODY_CAP)
}

/// The folded coverage line for an Enforce convention.
fn render_coverage(cov: &Coverage) -> String {
    let mut parts = vec![format!("status {}", one_line(&cov.status))];
    if !cov.enforced_by.is_empty() {
        let rules: Vec<String> = cov.enforced_by.iter().map(|r| code_span(r)).collect();
        parts.push(format!("enforced by {}", rules.join(", ")));
    }
    if !cov.documented_in.is_empty() {
        let docs: Vec<String> = cov.documented_in.iter().map(|d| code_span(d)).collect();
        parts.push(format!("documented in {}", docs.join(", ")));
    }
    if let Some(artifact) = &cov.suggested_artifact_kind {
        parts.push(format!("suggested artifact {}", code_span(artifact)));
    }
    format!("\n**Coverage:** {}\n", parts.join(" · "))
}

/// One evidence bullet: `- <prose detail> — <code_span location>` (either part may be
/// absent).
fn render_evidence(e: &Evidence) -> String {
    match (&e.detail, &e.location) {
        (Some(detail), Some(loc)) => format!("- {} — {}\n", prose(detail), code_span(loc)),
        (Some(detail), None) => format!("- {}\n", prose(detail)),
        (None, Some(loc)) => format!("- {}\n", code_span(loc)),
        (None, None) => String::new(),
    }
}
