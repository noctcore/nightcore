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
//! **No side effects, least privilege.** The CLI runs in print mode with ALL tools
//! disallowed — mutation AND read/network (`--disallowed-tools Bash,Edit,Write,…,
//! Read,Glob,Grep,WebFetch,WebSearch,…`) — and external MCP servers suppressed
//! (`--strict-mcp-config`). The payload is partly attacker-influenceable (task
//! title/description) and the output is committed verbatim, so the generation pass
//! must be unable to read local secrets or exfiltrate them: it gets only its stdin.
//! The diff is fed on **stdin** (no arg-length limit for large diffs); the
//! instruction is the one positional prompt — which MUST precede the variadic
//! `--disallowed-tools` flag or the CLI swallows it as tool names. A wall-clock
//! timeout kills a hung child.

use std::io::{Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::store::TaskStore;
use crate::task::Task;

/// Max characters of staged diff fed to the model. A large refactor can produce a
/// huge diff; the subject line only needs the shape of the change, so we cap it
/// (the model still sees the full intent via the task + transcript digest).
const DIFF_CAP: usize = 12_000;

/// Max characters of transcript digest included as secondary context.
const DIGEST_CAP: usize = 1_500;

/// Hard wall-clock bound on the `claude -p` child. Haiku typically answers in a few
/// seconds; this only fires on a genuine hang, after which we fall back to the title.
const GEN_TIMEOUT: Duration = Duration::from_secs(30);

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

/// Borrow at most `max` bytes of `s`, ending on a char boundary (so a multi-byte
/// glyph is never split). Appends a truncation marker when it cuts.
fn cap(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Spawn `claude -p` (resolved cross-platform via the platform layer), feed `stdin`
/// the context, and return its stdout — or `None` on spawn failure, non-zero exit,
/// or timeout. The child runs with mutation tools disallowed and external MCP
/// suppressed, so it can read but never modify the repo.
fn run_claude(instruction: &str, stdin_payload: &str) -> Option<String> {
    // Arg order matters: the instruction is the positional prompt and MUST come
    // right after `-p`, BEFORE the variadic `--disallowed-tools <tools...>` flag.
    // If the prompt trails the variadic flag, the CLI greedily consumes the prompt's
    // words as tool names (verified against claude 2.1.195) — the instruction is lost
    // and the model answers from stdin alone, silently producing a garbage message.
    // Keeping `--disallowed-tools` last bounds the variadic to its one comma value.
    let mut child = crate::platform::std_command("claude")
        .arg("-p")
        .arg(instruction)
        .args([
            "--model",
            "haiku",
            "--strict-mcp-config",
            "--output-format",
            "text",
            // Least privilege: the diff arrives on stdin, so the run needs ZERO
            // tools. Deny mutation AND read/network tools — the payload (task title,
            // diff, transcript) is partly untrusted, and the output is committed
            // verbatim, so a prompt injection must not be able to read local secrets
            // or exfiltrate over the network. `--strict-mcp-config` covers MCP; these
            // are the built-ins.
            "--disallowed-tools",
            "Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // stderr is discarded, not piped: an undrained stderr pipe could fill its OS
        // buffer (claude can be chatty with warnings) and block the child on write
        // forever — stalling the commit until the timeout. We never read stderr.
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            tracing::warn!(target: "nightcore::commit", error = %e, "could not spawn `claude` for commit message; falling back to title");
        })
        .ok()?;

    // Feed stdin from a detached thread so a large diff can't deadlock against a
    // child that is also writing stdout (dropping the handle closes the pipe / EOF).
    if let Some(mut stdin) = child.stdin.take() {
        let payload = stdin_payload.as_bytes().to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&payload);
        });
    }

    // Drain stdout on a thread for the same reason; join it after the child exits.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });

    // Poll for exit with a wall-clock bound; kill a child that overruns it.
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() > GEN_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    tracing::warn!(target: "nightcore::commit", "`claude` commit-message generation timed out; falling back to title");
                    return None;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            // Symmetric with the timeout branch: reap the child and close its pipes
            // (unblocking the stdin-writer and stdout-reader threads) before bailing.
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };

    let out = reader.join().ok()?;
    if !status.success() {
        tracing::warn!(target: "nightcore::commit", code = ?status.code(), "`claude` exited non-zero for commit message; falling back to title");
        return None;
    }
    Some(out)
}

/// Clean the model's raw stdout into a commit message: strip a wrapping ``` fence if
/// present, trim, and cap the total length. Returns `None` when nothing usable
/// remains (so the caller falls back to the title).
fn sanitize(raw: &str) -> Option<String> {
    /// A commit message longer than this is almost certainly the model rambling;
    /// reject the tail rather than write a wall of text into git history.
    const MESSAGE_CAP: usize = 4_000;

    let mut text = raw.trim();

    // Strip a single wrapping code fence (```…``` or ```text …```) if the whole
    // message is fenced — a common formatting habit despite the instruction.
    if let Some(rest) = text.strip_prefix("```") {
        // Drop the rest of the opening fence line (e.g. "```text\n").
        let after_lang = rest.find('\n').map(|i| &rest[i + 1..]).unwrap_or("");
        text = after_lang.strip_suffix("```").unwrap_or(after_lang).trim();
    }

    let text = text.trim();
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
