//! Conventional-commit message generation via `claude -p` (the commit button).
//!
//! The commit button used to label a commit with the task's title verbatim. This
//! module instead asks the user's installed `claude` CLI (headless print mode) to
//! read the **staged diff** — plus the task's intent and a digest of its run
//! transcript — and write a Conventional Commits message.
//!
//! **Robustness over cleverness.** Generation is strictly best-effort: every
//! failure mode (no `claude` on PATH, a non-zero exit, a timeout, empty/garbage
//! output) collapses to `None`, and the caller falls back to the title-based
//! message. A commit must never fail because message generation failed.
//!
//! The CLI spawn itself (print mode, ALL tools disallowed, stdin-fed context,
//! the positional-prompt-before-variadic-flag arg-order gotcha, the 30s
//! timeout) lives in the shared [`super::claude_oneshot`] core, which the PR
//! drafter ([`super::pr_msg`]) reuses; this module owns only the commit-shaped
//! instruction, payload, and sanitize pass.

use std::path::Path;

use super::claude_oneshot::{cap, run_claude, strip_code_fence};
use crate::store::TaskStore;
use crate::task::Task;

/// Max characters of staged diff fed to the model. A large refactor can produce a
/// huge diff; the subject line only needs the shape of the change, so we cap it
/// (the model still sees the full intent via the task + transcript digest).
const DIFF_CAP: usize = 12_000;

/// Max characters of transcript digest included as secondary context.
const DIGEST_CAP: usize = 1_500;

/// The fixed instruction (the single positional prompt). All variable context —
/// task intent, transcript digest, and the diff — arrives on stdin.
const INSTRUCTION: &str = "You are writing a git commit message. The staged changes \
and surrounding context are provided on stdin. Output ONLY a Conventional Commits \
message and nothing else: a single `type(scope): subject` line (lowercase type from \
feat|fix|docs|style|refactor|perf|test|build|ci|chore, imperative subject, no \
trailing period, ideally <=72 chars), optionally followed by a blank line and a \
short body of bullet points. Do NOT include code fences, backticks, preamble, \
explanation, or quotes around the message.";

/// Generate a Conventional Commits message for the changes staged in `dir`, using
/// the task's title/description and a digest of its transcript as context. Returns
/// `None` on any failure so the caller can fall back to the title-based message.
pub fn generate_for(store: &TaskStore, dir: &Path, task: &Task) -> Option<String> {
    let diff = crate::worktree::staged_diff(dir).ok()?;
    if diff.trim().is_empty() {
        return None;
    }
    let digest = crate::transcript::digest(store, &task.id, DIGEST_CAP);
    let payload = build_payload(&task.title, &task.description, &digest, &diff);
    let raw = run_claude(INSTRUCTION, &payload)?;
    sanitize(&raw)
}

/// Assemble the stdin context: task intent, an optional (possibly noisy) transcript
/// digest, and the (capped) staged diff — clearly delimited so the model can tell
/// the authoritative diff from the advisory context.
fn build_payload(title: &str, description: &str, digest: &str, diff: &str) -> String {
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
    out.push_str("\n\n### Staged diff (authoritative — describe THIS)\n");
    out.push_str(cap(diff, DIFF_CAP));
    out
}

/// Clean the model's raw stdout into a commit message: strip a wrapping ``` fence if
/// present, trim, and cap the total length. Returns `None` when nothing usable
/// remains (so the caller falls back to the title).
fn sanitize(raw: &str) -> Option<String> {
    /// A commit message longer than this is almost certainly the model rambling;
    /// reject the tail rather than write a wall of text into git history.
    const MESSAGE_CAP: usize = 4_000;

    let text = strip_code_fence(raw);
    if text.is_empty() {
        return None;
    }
    Some(cap(text, MESSAGE_CAP).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_never_splits_a_multibyte_char() {
        // "é" is two bytes; a cap landing mid-glyph must back off to a boundary.
        let s = "aé";
        assert_eq!(cap(s, 2), "a", "backs off the multi-byte boundary");
        assert_eq!(cap(s, 3), "aé", "exact length keeps everything");
        assert_eq!(cap("abc", 10), "abc", "under-cap is a no-op");
    }

    #[test]
    fn sanitize_strips_a_wrapping_code_fence() {
        let fenced = "```\nfeat(board): add drag and drop\n```";
        assert_eq!(
            sanitize(fenced).as_deref(),
            Some("feat(board): add drag and drop")
        );
        let lang_fenced = "```text\nfix(core): clear the lock\n```";
        assert_eq!(
            sanitize(lang_fenced).as_deref(),
            Some("fix(core): clear the lock")
        );
    }

    #[test]
    fn sanitize_passes_through_a_plain_message_and_trims() {
        assert_eq!(
            sanitize("  chore: bump deps  \n").as_deref(),
            Some("chore: bump deps")
        );
    }

    #[test]
    fn sanitize_rejects_empty_output() {
        assert!(sanitize("   \n  ").is_none());
        assert!(sanitize("```\n```").is_none());
    }

    #[test]
    fn build_payload_orders_intent_then_digest_then_diff() {
        let payload = build_payload(
            "Add login",
            "OAuth flow",
            "[Read] wrote auth.ts",
            "diff --git a b",
        );
        let task_at = payload.find("### Task").unwrap();
        let notes_at = payload.find("### Agent notes").unwrap();
        let diff_at = payload.find("### Staged diff").unwrap();
        assert!(
            task_at < notes_at && notes_at < diff_at,
            "sections are ordered"
        );
        assert!(payload.contains("Add login"));
        assert!(payload.contains("OAuth flow"));
        assert!(payload.contains("diff --git a b"));
    }

    #[test]
    fn build_payload_omits_empty_digest_and_description() {
        let payload = build_payload("Title only", "", "", "the diff");
        assert!(
            !payload.contains("### Agent notes"),
            "no notes section when digest empty"
        );
        assert!(payload.contains("Title only"));
        assert!(payload.contains("the diff"));
    }
}
