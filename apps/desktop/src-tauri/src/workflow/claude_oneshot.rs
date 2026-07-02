//! The shared `claude -p` one-shot: the text-generation core behind the
//! commit-message generator ([`super::commit_msg`]) and the PR drafter
//! ([`super::pr_msg`]).
//!
//! Spawns the user's installed `claude` CLI (headless print mode, `--model
//! haiku`), feeds all variable context on **stdin**, and returns raw stdout.
//! Strictly best-effort: every failure mode (no `claude` on PATH, a non-zero
//! exit, a timeout, empty output) collapses to `None`, and each caller falls
//! back to its own deterministic message — generation must never break the
//! action it decorates.
//!
//! **No side effects, least privilege.** The CLI runs with ALL tools disallowed
//! — mutation AND read/network (`--disallowed-tools Bash,Edit,Write,…,Read,
//! Glob,Grep,WebFetch,WebSearch,…`) — and external MCP servers suppressed
//! (`--strict-mcp-config`). The payloads are partly attacker-influenceable
//! (task title/description, repo diffs) and the outputs are committed/published
//! verbatim, so the generation pass must be unable to read local secrets or
//! exfiltrate them: it gets only its stdin. The instruction is the one
//! positional prompt — which MUST precede the variadic `--disallowed-tools`
//! flag or the CLI swallows it as tool names. A wall-clock timeout kills a hung
//! child.

use std::io::{Read, Write};
use std::process::Stdio;
use std::time::{Duration, Instant};

/// Hard wall-clock bound on the `claude -p` child. Haiku typically answers in a few
/// seconds; this only fires on a genuine hang, after which the caller falls back to
/// its deterministic message.
const GEN_TIMEOUT: Duration = Duration::from_secs(30);

/// Spawn `claude -p` (resolved cross-platform via the platform layer), feed `stdin`
/// the context, and return its stdout — or `None` on spawn failure, non-zero exit,
/// or timeout. The child runs with every tool disallowed and external MCP
/// suppressed, so it can never read or modify anything beyond its stdin.
pub(crate) fn run_claude(instruction: &str, stdin_payload: &str) -> Option<String> {
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
            // diff, transcript) is partly untrusted, and the output is used
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
        // forever — stalling the caller until the timeout. We never read stderr.
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            tracing::warn!(target: "nightcore::oneshot", error = %e, "could not spawn `claude` for one-shot generation; falling back");
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
                    tracing::warn!(target: "nightcore::oneshot", "`claude` one-shot generation timed out; falling back");
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
        tracing::warn!(target: "nightcore::oneshot", code = ?status.code(), "`claude` exited non-zero for one-shot generation; falling back");
        return None;
    }
    Some(out)
}

/// Borrow at most `max` bytes of `s`, ending on a char boundary (so a multi-byte
/// glyph is never split).
pub(crate) fn cap(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Strip a single wrapping code fence (```…``` or ```text …```) if the whole text
/// is fenced — a common model formatting habit despite the instructions — and trim.
/// The shared first step of each caller's sanitize pass.
pub(crate) fn strip_code_fence(raw: &str) -> &str {
    let mut text = raw.trim();
    if let Some(rest) = text.strip_prefix("```") {
        // Drop the rest of the opening fence line (e.g. "```text\n").
        let after_lang = rest.find('\n').map(|i| &rest[i + 1..]).unwrap_or("");
        text = after_lang.strip_suffix("```").unwrap_or(after_lang).trim();
    }
    text.trim()
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
    fn strip_code_fence_unwraps_fenced_and_lang_fenced_text() {
        assert_eq!(strip_code_fence("```\nhello\n```"), "hello");
        assert_eq!(strip_code_fence("```text\nhello\n```"), "hello");
        assert_eq!(strip_code_fence("  plain  "), "plain");
        assert_eq!(strip_code_fence("```\n```"), "", "an empty fence is empty");
    }
}
