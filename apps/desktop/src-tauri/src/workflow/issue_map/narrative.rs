//! The ONE cheap, fail-open LLM pass (§3.5): a `claude -p --model haiku` one-shot
//! that writes the parent's executive summary + a one-line intro per group. It
//! DECORATES the deterministic plan — it never invents structure.
//!
//! Fail-open by construction: [`crate::workflow::oneshot::run_oneshot`] collapses
//! EVERY failure (no `claude` on PATH, non-zero exit, timeout, empty output) to
//! `None`, and unparseable output is treated the same, so this always returns a
//! [`Narrative`] — the LLM's when usable, else a deterministic template — plus a bool
//! recording which branch ran (`narrative_ok`, surfaced subtly in the UI). The pass
//! is fed only finding TITLES + the deterministic group summary on stdin, and the
//! one-shot disallows every tool + suppresses MCP, so a prompt injection in a title
//! can neither read local secrets nor exfiltrate — it gets only its stdin.

use serde_json::Value;

use super::contract::{GroupIntro, Narrative};
use super::plan::IssueMapPlan;
use crate::workflow::github_md::prose;
use crate::workflow::oneshot::{cap, resolve_oneshot_binary, run_oneshot_with, strip_code_fence};

/// The fixed instruction (the one positional prompt; all context is on stdin).
const INSTRUCTION: &str = "You are writing a short editorial summary for a GitHub \
issue that maps a codebase-scan's findings. The deterministic groups and finding \
titles are on stdin. Output ONLY compact JSON and nothing else: \
{\"summary\": \"a 2-3 sentence executive summary of the scan\", \"intros\": \
{\"<group label>\": \"a one-line intro for that group\"}}. Use the EXACT group \
labels from the input as the keys. Do NOT invent findings, counts, or groups. Do \
NOT include code fences, backticks, preamble, or explanation.";

/// Cap on the summary / each intro fed back into the parent body (defensive — the
/// narrative is cosmetic prose, not a document).
const SUMMARY_CAP: usize = 800;
const INTRO_CAP: usize = 300;

/// Generate the narrative for `plan` (production entry — resolves the real `claude`).
pub(crate) fn generate(plan: &IssueMapPlan) -> (Narrative, bool) {
    generate_with(&resolve_oneshot_binary(), plan)
}

/// Binary-parameterized generate (the fake-one-shot test seam). Runs the one-shot,
/// parses + sanitizes its JSON, and falls open to [`fallback`] on any failure.
pub(crate) fn generate_with(binary: &str, plan: &IssueMapPlan) -> (Narrative, bool) {
    let payload = build_payload(plan);
    match run_oneshot_with(binary, INSTRUCTION, &payload).and_then(|raw| parse(&raw, plan)) {
        Some(narrative) => (narrative, true),
        None => (fallback(plan), false),
    }
}

/// Assemble the stdin context: the deterministic scan/group summary + each group's
/// finding titles, clearly delimited (the `commit_msg::build_payload` idiom).
fn build_payload(plan: &IssueMapPlan) -> String {
    let total = plan.total();
    let mut out = format!(
        "### Scan\n{} — {} {} across {} group(s).\n\n### Groups\n",
        plan.kind.display(),
        total,
        plan.kind.noun(total),
        plan.groups.len(),
    );
    for group in &plan.groups {
        out.push_str(&format!("- {} ({}):\n", group.label, group.items.len()));
        for item in &group.items {
            out.push_str(&format!("  - {}\n", cap(item.title.trim(), 200)));
        }
    }
    out
}

/// Parse the model's JSON into a [`Narrative`], keeping ONLY intros whose key matches
/// a real plan group label (so the model can't inject phantom groups) and sanitizing
/// every string as untrusted prose. `None` (⇒ fall back) on unparseable output or an
/// empty summary.
fn parse(raw: &str, plan: &IssueMapPlan) -> Option<Narrative> {
    let v: Value = serde_json::from_str(strip_code_fence(raw)).ok()?;
    let summary = prose(v.get("summary")?.as_str()?);
    let summary = cap(&summary, SUMMARY_CAP).trim().to_string();
    if summary.is_empty() {
        return None;
    }
    let intros_obj = v.get("intros").and_then(Value::as_object);
    let group_intros = plan
        .groups
        .iter()
        .filter_map(|g| {
            let raw = intros_obj?.get(&g.label)?.as_str()?;
            let intro = cap(prose(raw).trim(), INTRO_CAP).trim().to_string();
            (!intro.is_empty()).then(|| GroupIntro {
                label: g.label.clone(),
                intro,
            })
        })
        .collect();
    Some(Narrative {
        exec_summary: summary,
        group_intros,
    })
}

/// The deterministic narrative used when the LLM pass fails/parses-empty: a templated
/// summary naming totals + a per-group intro naming the count. Never reads the clock
/// or invents content.
fn fallback(plan: &IssueMapPlan) -> Narrative {
    let total = plan.total();
    let exec_summary = format!(
        "Nightcore {} surfaced {} {} across {} group(s).",
        plan.kind.display(),
        total,
        plan.kind.noun(total),
        plan.groups.len(),
    );
    let group_intros = plan
        .groups
        .iter()
        .map(|g| {
            let count = g.items.len() as u32;
            GroupIntro {
                label: g.label.clone(),
                intro: format!("{} {}.", count, plan.kind.noun(count)),
            }
        })
        .collect();
    Narrative {
        exec_summary,
        group_intros,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::issue_map::plan::build_insight_plan;
    use crate::workflow::issue_map::tests_support::insight_run;

    #[cfg(unix)]
    fn fake_oneshot(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-claude.sh");
        std::fs::write(&path, format!("#!/bin/sh\ncat >/dev/null\n{body}\n")).expect("write");
        let mut perms = std::fs::metadata(&path).expect("meta").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod");
        path
    }

    #[test]
    #[cfg(unix)]
    fn valid_json_parses_and_keeps_only_real_group_labels() {
        let tmp = tempfile::TempDir::new().expect("tmp");
        // Intros include a phantom "ghost" group that must be dropped.
        let script = fake_oneshot(
            tmp.path(),
            "printf '%s' '{\"summary\":\"Two issues found.\",\"intros\":{\"bugs\":\"Bug intro.\",\"ghost\":\"nope\"}}'",
        );
        let plan = build_insight_plan(&insight_run());
        let (narrative, ok) = generate_with(script.to_str().unwrap(), &plan);
        assert!(ok, "valid JSON ⇒ narrative_ok");
        assert_eq!(narrative.exec_summary, "Two issues found.");
        assert!(
            narrative.group_intros.iter().all(|g| g.label != "ghost"),
            "a phantom group label is dropped"
        );
        assert!(
            narrative.group_intros.iter().any(|g| g.label == "bugs"),
            "a real group intro is kept"
        );
    }

    #[test]
    #[cfg(unix)]
    fn empty_garbage_and_nonzero_all_fall_open_to_deterministic() {
        let plan = build_insight_plan(&insight_run());
        for body in ["", "printf 'not json at all'", "exit 1"] {
            let tmp = tempfile::TempDir::new().expect("tmp");
            let script = fake_oneshot(tmp.path(), body);
            let (narrative, ok) = generate_with(script.to_str().unwrap(), &plan);
            assert!(!ok, "failure ⇒ narrative_ok is false for body {body:?}");
            assert!(
                narrative
                    .exec_summary
                    .contains("Nightcore Insight surfaced"),
                "deterministic fallback summary used for body {body:?}"
            );
            assert_eq!(
                narrative.group_intros.len(),
                plan.groups.len(),
                "one deterministic intro per group"
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn a_control_char_in_the_summary_is_sanitized() {
        let tmp = tempfile::TempDir::new().expect("tmp");
        let script = fake_oneshot(
            tmp.path(),
            "printf '%s' '{\"summary\":\"clean\\u001b[31m tail\",\"intros\":{}}'",
        );
        let plan = build_insight_plan(&insight_run());
        let (narrative, ok) = generate_with(script.to_str().unwrap(), &plan);
        assert!(ok);
        assert!(
            !narrative.exec_summary.contains('\u{1b}'),
            "escape char stripped from the model summary"
        );
    }
}
