//! The ONE canonical markdown renderer for a `TrustReport`. Feeds all three
//! surfaces — local export, the in-drawer preview (PR 2), and the GitHub PR
//! attachment (PR 3) — so there is exactly one rendering of the receipt. It sits
//! beside the house comment-builders `compose_push_comment`
//! (`workflow::pr_fix::comment`) and `composeReviewBody` (`prreview-compose.ts`).
//!
//! Two thin entry points over one body builder:
//! - [`render_markdown`] — local export (the user's own machine; an `#` title).
//! - [`render_for_github`] — the same body under a `###` house header + the
//!   `_Posted from Nightcore._` footer, for a PR comment/body.
//!
//! UNTRUSTED-CONTENT RULE (§3.6): the ledger `files_touched`/`commands` digests are
//! repo/agent-derived and may carry adversarial text (backticks, ``` fences,
//! control chars). This later lands on GitHub, so every untrusted span is rendered
//! via [`code_span`]: control chars → spaces + whitespace collapsed (the
//! `sanitize_minted_title` idiom) then fenced with a backtick run strictly longer
//! than any run inside it (the `defuse_fence` idea) so nothing can break out of its
//! code span. The prompt-only `untrusted_block` is deliberately NOT used here (it
//! frames text INTO an agent, and renders as noise in a markdown body).

use super::contract::{GuardrailEvent, TrustReport};

/// The house GitHub header/footer (the `compose_push_comment` idiom).
const GH_HEADER: &str = "### 🌙 Nightcore — Trust report";
const GH_FOOTER: &str = "_Posted from Nightcore._";

/// Render the receipt as a standalone markdown document (local export).
pub(crate) fn render_markdown(report: &TrustReport) -> String {
    let mut lines = vec![format!("# 🌙 Nightcore — Trust report: {}", report.title)];
    lines.push(String::new());
    body_lines(report, &mut lines);
    lines.join("\n")
}

/// Render the receipt for a GitHub PR body/comment: the same body under the house
/// `###` header + `_Posted from Nightcore._` footer.
pub(crate) fn render_for_github(report: &TrustReport) -> String {
    let mut lines = vec![format!("{GH_HEADER}: {}", report.title)];
    lines.push(String::new());
    body_lines(report, &mut lines);
    lines.push(String::new());
    lines.push("---".to_string());
    lines.push(GH_FOOTER.to_string());
    lines.join("\n")
}

/// The shared body: provenance meta + the three grounded sections.
fn body_lines(report: &TrustReport, lines: &mut Vec<String>) {
    meta_lines(report, lines);
    gauntlet_lines(report, lines);
    guardrail_lines(report, lines);
    flight_lines(report, lines);
}

/// Provenance — every claim traces to a persisted record (task id, branch/base,
/// PR, mint time).
fn meta_lines(report: &TrustReport, lines: &mut Vec<String>) {
    lines.push(format!(
        "**Task** {} · **status** `{}` · **mode** `{}`",
        code_span(&report.task_id),
        wire_str(report.status),
        wire_str(report.run_mode),
    ));
    if let Some(branch) = report.branch.as_deref() {
        let base = report.base_branch.as_deref().unwrap_or("(project base)");
        lines.push(format!(
            "**Branch** {} → {}",
            code_span(branch),
            code_span(base)
        ));
    }
    if let Some(url) = report.pr_url.as_deref() {
        match report.pr_number {
            Some(n) => lines.push(format!("**PR** #{n} — {url}")),
            None => lines.push(format!("**PR** {url}")),
        }
    }
    lines.push(format!("_Generated {}._", report.generated_at));
}

/// The gauntlet + reviewer section, read verbatim off the task (never re-run).
fn gauntlet_lines(report: &TrustReport, lines: &mut Vec<String>) {
    let g = &report.gauntlet;
    lines.push(String::new());
    lines.push("## Gauntlet & review".to_string());
    lines.push(format!(
        "- **Verified:** {}",
        if g.verified { "✅ yes" } else { "❌ no" }
    ));
    match g.verdict.as_deref() {
        Some(line) => lines.push(format!("- **Reviewer verdict:** {}", one_line(line))),
        None => lines.push("- **Reviewer verdict:** _none recorded_".to_string()),
    }
    lines.push(format!("- **Auto-fix rounds:** {}", g.fix_attempts));

    match &g.structure_lock {
        None => lines.push("- **Structure-lock gauntlet:** _not run_".to_string()),
        Some(sl) => {
            let head = if sl.passed {
                "✅ PASSED".to_string()
            } else {
                match sl.failed_check.as_deref() {
                    Some(name) => format!("❌ FAILED at {}", code_span(name)),
                    None => "❌ FAILED".to_string(),
                }
            };
            lines.push(format!(
                "- **Structure-lock gauntlet:** {head} ({} check{})",
                sl.checks.len(),
                if sl.checks.len() == 1 { "" } else { "s" }
            ));
            for c in &sl.checks {
                lines.push(format!(
                    "  - `{}` **{}** — {} ({})",
                    sanitize_label(&c.kind),
                    sanitize_label(&c.name),
                    wire_str(c.status),
                    code_span(&c.command),
                ));
            }
        }
    }
}

/// The guardrail section: durable deny/ask/allow tiers + policy holds.
fn guardrail_lines(report: &TrustReport, lines: &mut Vec<String>) {
    let g = &report.guardrails;
    lines.push(String::new());
    lines.push("## Guardrails".to_string());
    lines.push(format!(
        "- **{} tool call{} evaluated** — allowed {} · asked {} · denied {}",
        g.tools_evaluated,
        if g.tools_evaluated == 1 { "" } else { "s" },
        g.allowed,
        g.asked,
        g.denied,
    ));
    if let Some(hold) = g.policy_hold.as_deref() {
        lines.push(format!("- **Policy hold:** {}", one_line(hold)));
    }
    if let Some(park) = g.scope_park.as_deref() {
        lines.push(format!(
            "- **Scope park (transient — only while parked):** {}",
            one_line(park)
        ));
    }
    event_lines("Denied actions", &g.blocked, lines);
    event_lines("Asked actions", &g.asked_events, lines);
}

/// Render a guardrail-event tier as an indented, code-fenced list.
fn event_lines(label: &str, events: &[GuardrailEvent], lines: &mut Vec<String>) {
    if events.is_empty() {
        return;
    }
    lines.push(format!("- **{label}:**"));
    for e in events {
        let mut parts = vec![format!("`{}`", sanitize_label(&e.tool))];
        if let Some(rule) = e.rule_id.as_deref() {
            parts.push(format!("rule `{}`", sanitize_label(rule)));
        }
        if let Some(digest) = e.digest.as_deref() {
            parts.push(code_span(digest));
        }
        if let Some(ts) = e.ts.as_deref() {
            parts.push(format!("_{}_", sanitize_label(ts)));
        }
        lines.push(format!("  - {}", parts.join(" — ")));
    }
}

/// The flight-recorder summary: sessions, touched files, commands, cost/tokens.
fn flight_lines(report: &TrustReport, lines: &mut Vec<String>) {
    let f = &report.flight;
    lines.push(String::new());
    lines.push("## Flight summary".to_string());
    lines.push(format!("- **Sessions:** {}", f.session_count));

    lines.push(format!("- **Files touched:** {}", f.files_touched_count));
    for path in &f.files_touched {
        lines.push(format!("  - {}", code_span(path)));
    }
    if f.files_touched.len() < f.files_touched_count as usize {
        lines.push(format!(
            "  - _…and {} more_",
            f.files_touched_count as usize - f.files_touched.len()
        ));
    }

    lines.push(format!("- **Commands run:** {}", f.commands_count));
    for cmd in &f.commands {
        lines.push(format!("  - {}", code_span(cmd)));
    }
    if f.commands.len() < f.commands_count as usize {
        lines.push(format!(
            "  - _…and {} more_",
            f.commands_count as usize - f.commands.len()
        ));
    }

    cost_lines(report, lines);
}

/// The cost + token lines, carrying the §6 under-count label on the total.
fn cost_lines(report: &TrustReport, lines: &mut Vec<String>) {
    let f = &report.flight;
    let last = f
        .cost_usd_last_run
        .map(money)
        .unwrap_or_else(|| "n/a".to_string());
    match f.cost_usd_total {
        Some(total) => lines.push(format!(
            "- **Cost:** last run {last} · ≈ {} total across {} session{} (excludes fix-session spend)",
            money(total),
            f.session_count,
            if f.session_count == 1 { "" } else { "s" },
        )),
        None => lines.push(format!("- **Cost:** last run {last}")),
    }
    if let Some(t) = f.tokens {
        lines.push(format!(
            "- **Tokens:** input {} · output {} · reasoning {} · cache read {} · cache creation {}",
            t.input, t.output, t.reasoning_output, t.cache_read, t.cache_creation,
        ));
    }
}

/// Render an UNTRUSTED string as a single GitHub-safe inline code span (§3.6):
/// control chars → spaces + whitespace collapsed (the `sanitize_minted_title`
/// idiom, which also caps + never returns empty), then fenced with a backtick run
/// strictly longer than any run inside the content (the `defuse_fence` idea) so a
/// crafted digest cannot break out of its span. CommonMark strips one leading +
/// trailing space when both are present, so pad when the content abuts a backtick.
pub(super) fn code_span(raw: &str) -> String {
    let clean = crate::task::sanitize_minted_title(raw, "(empty)");
    let fence = "`".repeat(longest_backtick_run(&clean) + 1);
    if clean.starts_with('`') || clean.ends_with('`') {
        format!("{fence} {clean} {fence}")
    } else {
        format!("{fence}{clean}{fence}")
    }
}

/// The longest run of consecutive backticks in `s` (0 when none).
pub(super) fn longest_backtick_run(s: &str) -> usize {
    let mut max = 0usize;
    let mut cur = 0usize;
    for ch in s.chars() {
        if ch == '`' {
            cur += 1;
            max = max.max(cur);
        } else {
            cur = 0;
        }
    }
    max
}

/// Collapse an untrusted label to one printable line (no fencing) — for spans
/// already inside our own backticks (a `kind`/`rule`), or for prose lines
/// (verdict/policy) that must not break the layout.
fn sanitize_label(raw: &str) -> String {
    crate::task::sanitize_minted_title(raw, "(none)")
}

/// A prose line collapsed to one printable line (control chars → spaces).
fn one_line(raw: &str) -> String {
    crate::task::sanitize_minted_title(raw, "(none)")
}

/// Format a USD amount for the receipt (4 dp — small agent costs need the tail).
fn money(x: f64) -> String {
    format!("${x:.4}")
}

/// The serde wire string of a small `Serialize` enum (`TaskStatus`/`RunMode`/
/// `StepStatus`), for a stable, drift-proof label.
fn wire_str<T: serde::Serialize>(v: T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}
