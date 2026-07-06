//! PR title/body drafting via the shared `claude -p` one-shot (PR arc, phase 1).
//!
//! The PR twin of [`super::commit_msg`], built on the same
//! [`super::oneshot`] core (least-privilege posture: ALL tools
//! disallowed, context on stdin, 30s timeout). Best-effort by the same
//! contract: any failure — no `claude`, non-zero exit, timeout, unusable
//! output, no committed diff — collapses to `None`, and the command falls back
//! to the deterministic pair (task title + task description). The result is
//! only ever PRE-FILLED into an editable dialog (design principle 5), never
//! posted directly.

use std::path::Path;

use super::oneshot::{cap, run_oneshot, strip_code_fence};
use super::pr::PrDraft;
use crate::store::TaskStore;
use crate::task::Task;

/// Max characters of the branch diff fed to the model (the `commit_msg` cap):
/// the title/summary needs the shape of the change, not every hunk.
const DIFF_CAP: usize = 12_000;

/// Max characters of transcript digest included as secondary context.
const DIGEST_CAP: usize = 1_500;

/// Cap on the drafted title — one line, roughly the minted-title bound.
const TITLE_CAP: usize = 200;

/// Cap on the drafted markdown body (the `commit_msg` message cap).
const BODY_CAP: usize = 4_000;

/// The fixed instruction (the single positional prompt). All variable context —
/// task intent, transcript digest, and the branch diff — arrives on stdin.
const INSTRUCTION: &str = "You are writing a GitHub pull request message. The \
branch's changes and surrounding context are provided on stdin. Output ONLY the \
PR message and nothing else. The FIRST line is the PR title in Conventional \
Commits style: a single `type(scope): subject` line (lowercase type from \
feat|fix|docs|style|refactor|perf|test|build|ci|chore, imperative subject, no \
trailing period). Then a blank line, then a markdown body with a `## Summary` \
section (what changed and why, short bullets) and a `## Test plan` section (how \
the change was verified). Do NOT include code fences, backticks, preamble, \
explanation, or quotes around the message.";

/// Draft a PR title + body for `task`'s worktree branch: the payload (task
/// intent, transcript digest, and the committed `git diff <base>...HEAD`) is
/// sent through the shared one-shot. `None` on any failure (including an empty
/// diff), so the caller falls back to the deterministic draft.
pub fn draft_for(store: &TaskStore, dir: &Path, task: &Task, base: &str) -> Option<PrDraft> {
    // `base_diff` validates the ref before it reaches git argv.
    let diff = crate::worktree::base_diff(dir, base).ok()?;
    if diff.trim().is_empty() {
        return None;
    }
    let digest = crate::transcript::digest(store, &task.id, DIGEST_CAP);
    let payload = build_payload(&task.title, &task.description, base, &digest, &diff);
    let raw = run_oneshot(INSTRUCTION, &payload)?;
    sanitize(&raw)
}

/// Assemble the stdin context: task intent, an optional (possibly noisy)
/// transcript digest, and the (capped) branch diff — clearly delimited so the
/// model can tell the authoritative diff from the advisory context (the
/// `commit_msg::build_payload` shape).
fn build_payload(title: &str, description: &str, base: &str, digest: &str, diff: &str) -> String {
    let mut out = String::new();
    out.push_str("### Task\n");
    out.push_str(title.trim());
    let description = description.trim();
    if !description.is_empty() {
        out.push('\n');
        out.push_str(description);
    }
    let digest = digest.trim();
    if !digest.is_empty() {
        out.push_str("\n\n### Agent notes (context only — may be noisy)\n");
        out.push_str(digest);
    }
    out.push_str("\n\n### Branch diff vs `");
    out.push_str(base);
    out.push_str("` (authoritative — describe THIS)\n");
    out.push_str(cap(diff, DIFF_CAP));
    out
}

/// Clean the model's raw stdout into a `PrDraft`: strip a wrapping code fence,
/// take the first line as the title (single line, capped) and the rest as the
/// markdown body (capped). `None` when nothing usable remains (so the caller
/// falls back to the deterministic draft).
fn sanitize(raw: &str) -> Option<PrDraft> {
    let text = strip_code_fence(raw);
    if text.is_empty() {
        return None;
    }
    let mut lines = text.lines();
    let title = cap(lines.next()?.trim(), TITLE_CAP).trim().to_string();
    if title.is_empty() {
        return None;
    }
    let rest = lines.collect::<Vec<_>>().join("\n");
    let body = cap(rest.trim(), BODY_CAP).trim().to_string();
    Some(PrDraft { title, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_payload_orders_intent_then_digest_then_diff_and_names_the_base() {
        let payload = build_payload(
            "Add login",
            "OAuth flow",
            "develop",
            "[Read] wrote auth.ts",
            "diff --git a b",
        );
        let task_at = payload.find("### Task").unwrap();
        let notes_at = payload.find("### Agent notes").unwrap();
        let diff_at = payload.find("### Branch diff").unwrap();
        assert!(
            task_at < notes_at && notes_at < diff_at,
            "sections are ordered"
        );
        assert!(payload.contains("Add login"));
        assert!(payload.contains("OAuth flow"));
        assert!(payload.contains("diff --git a b"));
        assert!(
            payload.contains("Branch diff vs `develop`"),
            "the base branch is named so the model knows the comparison point"
        );
    }

    #[test]
    fn build_payload_omits_empty_digest_and_description() {
        let payload = build_payload("Title only", "", "main", "", "the diff");
        assert!(
            !payload.contains("### Agent notes"),
            "no notes section when the digest is empty"
        );
        assert!(payload.contains("Title only"));
        assert!(payload.contains("the diff"));
    }

    #[test]
    fn build_payload_caps_a_huge_diff() {
        let huge = "x".repeat(DIFF_CAP + 5_000);
        let payload = build_payload("t", "", "main", "", &huge);
        assert!(
            payload.len() < huge.len(),
            "the diff is capped, not passed whole"
        );
    }

    #[test]
    fn sanitize_splits_title_and_body_and_strips_fences() {
        let raw = "```\nfeat(pr): add the create flow\n\n## Summary\n- did stuff\n\n\
                   ## Test plan\n- cargo test\n```";
        let draft = sanitize(raw).expect("usable draft");
        assert_eq!(draft.title, "feat(pr): add the create flow");
        assert!(
            draft.body.starts_with("## Summary"),
            "the body starts after the blank line: {}",
            draft.body
        );
        assert!(draft.body.contains("## Test plan"));
        assert!(!draft.body.contains("```"), "fences are stripped");
    }

    #[test]
    fn sanitize_tolerates_a_title_only_draft() {
        let draft = sanitize("fix(core): clear the lock\n").expect("usable draft");
        assert_eq!(draft.title, "fix(core): clear the lock");
        assert_eq!(draft.body, "", "no body is an empty string, not a failure");
    }

    #[test]
    fn sanitize_rejects_empty_output_and_caps_the_title() {
        assert!(sanitize("   \n  ").is_none());
        assert!(sanitize("```\n```").is_none());

        let long_title = "a".repeat(TITLE_CAP + 100);
        let draft = sanitize(&format!("{long_title}\n\nbody")).expect("usable draft");
        assert!(
            draft.title.len() <= TITLE_CAP,
            "the title is capped to ~{TITLE_CAP} chars"
        );
        assert!(
            !draft.title.contains('\n'),
            "the title is a single line by construction"
        );
        assert_eq!(draft.body, "body");
    }

    #[test]
    fn sanitize_caps_a_rambling_body() {
        let rambling = format!("feat: x\n\n{}", "b".repeat(BODY_CAP + 500));
        let draft = sanitize(&rambling).expect("usable draft");
        assert!(draft.body.len() <= BODY_CAP, "the body is capped");
    }
}
