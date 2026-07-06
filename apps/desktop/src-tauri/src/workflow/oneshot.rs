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
//!
//! **Binary resolution (issue #18).** The production entry points resolve the
//! binary through [`resolve_oneshot_binary`], which honors the SAME override env
//! vars as the engine's `resolve-claude-binary.ts` — `NIGHTCORE_AGENT_PATH ??
//! NIGHTCORE_CLAUDE_PATH` and `NIGHTCORE_USE_SYSTEM_CLAUDE` — so the one-shot and
//! the main agent loop can be pointed at the SAME `claude` instead of silently
//! diverging (the one-shot used a bare PATH lookup before). The engine's
//! `$bunfs` SDK-package resolution is engine-specific and deliberately not
//! mirrored here.

use std::process::Stdio;
use std::time::Duration;

/// Hard wall-clock bound on the `claude -p` child. Haiku typically answers in a few
/// seconds; this only fires on a genuine hang, after which the caller falls back to
/// its deterministic message.
const GEN_TIMEOUT: Duration = Duration::from_secs(30);

/// Generalized agent-binary override (issue #18), read FIRST. Falls back to the
/// legacy [`CLAUDE_PATH_ENV`] so existing setups keep working — an additive alias,
/// NOT a rename of the documented `NIGHTCORE_CLAUDE_PATH` var.
const AGENT_PATH_ENV: &str = "NIGHTCORE_AGENT_PATH";
/// Legacy Claude-specific binary override, honored as the fallback of
/// [`AGENT_PATH_ENV`] and shared verbatim with the engine's resolver.
const CLAUDE_PATH_ENV: &str = "NIGHTCORE_CLAUDE_PATH";
/// Opt-in to the system `claude` off PATH. See [`resolve_oneshot_binary`] for why
/// it is honored-by-construction in the Rust one-shot tier.
const USE_SYSTEM_ENV: &str = "NIGHTCORE_USE_SYSTEM_CLAUDE";
/// The bare binary handed to the platform launcher when no explicit override
/// resolves — the OS PATH lookup the one-shot has always used, and the
/// system-`claude` target of [`USE_SYSTEM_ENV`].
const DEFAULT_ONESHOT_BINARY: &str = "claude";

/// Spawn the one-shot agent binary (resolved via [`resolve_oneshot_binary`], then
/// cross-platform via the platform layer), feed `stdin` the context, and return
/// its stdout — or `None` on spawn failure, non-zero exit, or timeout. The child
/// runs with every tool disallowed and external MCP suppressed, so it can never
/// read or modify anything beyond its stdin.
pub(crate) fn run_oneshot(instruction: &str, stdin_payload: &str) -> Option<String> {
    run_oneshot_with(&resolve_oneshot_binary(), instruction, stdin_payload)
}

/// Resolve the binary the one-shot pass should spawn, honoring the SAME override
/// env vars as the engine's `resolve-claude-binary.ts` so the one-shot and the
/// main agent loop can be pointed at the SAME `claude`. Precedence mirrors the
/// engine, minus its engine-only `$bunfs` SDK-package resolution:
///
///   1. `NIGHTCORE_AGENT_PATH ?? NIGHTCORE_CLAUDE_PATH` — explicit path override
///      (new name first, legacy name as fallback). Used verbatim only when it
///      names a real, executable file on disk; a stale/garbage value is ignored so
///      the one-shot still runs off PATH rather than failing.
///   2. Otherwise the bare `claude` off PATH (see [`DEFAULT_ONESHOT_BINARY`]).
///
/// `NIGHTCORE_USE_SYSTEM_CLAUDE` is honored by construction: in the engine it opts
/// OUT of the SDK-pinned package binary in favour of a PATH `claude`, but the Rust
/// one-shot has no bundled binary tier, so PATH `claude` is already its only
/// non-override target — the flag never changes the outcome here. It is read below
/// so both override envs the engine honors are observed in this tier too.
pub(crate) fn resolve_oneshot_binary() -> String {
    let agent = std::env::var(AGENT_PATH_ENV).ok();
    let claude = std::env::var(CLAUDE_PATH_ENV).ok();
    let binary = choose_oneshot_binary(agent.as_deref(), claude.as_deref(), is_real_executable);
    tracing::debug!(
        target: "nightcore::oneshot",
        use_system = is_truthy_env(std::env::var(USE_SYSTEM_ENV).ok().as_deref()),
        binary = %binary,
        "resolved one-shot agent binary",
    );
    binary
}

/// Pure precedence core (env- and filesystem-free so the ordering is unit-testable
/// without mutating process-global env): the `agent_path ?? claude_path` override
/// when it names an executable per `exists`, else the PATH default
/// ([`DEFAULT_ONESHOT_BINARY`]). Empty override values are treated as unset.
fn choose_oneshot_binary(
    agent_path: Option<&str>,
    claude_path: Option<&str>,
    exists: impl Fn(&str) -> bool,
) -> String {
    let override_path = agent_path
        .filter(|s| !s.is_empty())
        .or(claude_path.filter(|s| !s.is_empty()));
    if let Some(path) = override_path {
        if exists(path) {
            return path.to_string();
        }
    }
    DEFAULT_ONESHOT_BINARY.to_string()
}

/// True only for a real, regular, executable file at `candidate` — the guard that
/// keeps a stale override path from being spawned (a bad value falls through to the
/// PATH default). Mirrors the engine resolver's `isRealExecutable`: a regular file
/// that is executable (`X_OK`) on POSIX; on Windows the access bit is meaningless,
/// so a regular file suffices.
#[cfg(unix)]
fn is_real_executable(candidate: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(candidate) {
        Ok(meta) => meta.is_file() && meta.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn is_real_executable(candidate: &str) -> bool {
    std::fs::metadata(candidate)
        .map(|meta| meta.is_file())
        .unwrap_or(false)
}

/// Treat an env value as truthy unless unset, empty, `"0"`, or `"false"` — the
/// engine resolver's `isTruthyEnv` semantics, mirrored so both tiers agree on what
/// [`USE_SYSTEM_ENV`] means.
fn is_truthy_env(value: Option<&str>) -> bool {
    !matches!(value, None | Some("") | Some("0") | Some("false"))
}

/// Binary-parameterized [`run_oneshot`] — the injection seam the tests drive with a
/// fake script to exercise the real spawn + exit-code/timeout path (mirrors the
/// `run_gh_bounded` binary parameter). Production callers use [`run_oneshot`], which
/// passes the resolved `claude`; the whole posture (least privilege, stdin-fed
/// context, the 30s bound) is identical.
pub(crate) fn run_oneshot_with(
    binary: &str,
    instruction: &str,
    stdin_payload: &str,
) -> Option<String> {
    // Arg order matters: the instruction is the positional prompt and MUST come
    // right after `-p`, BEFORE the variadic `--disallowed-tools <tools...>` flag.
    // If the prompt trails the variadic flag, the CLI greedily consumes the prompt's
    // words as tool names (verified against claude 2.1.195) — the instruction is lost
    // and the model answers from stdin alone, silently producing a garbage message.
    // Keeping `--disallowed-tools` last bounds the variadic to its one comma value.
    let child = crate::platform::std_command(binary)
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
        // forever — stalling the caller until the timeout. We never read stderr, and
        // the shared runner drains a `null` stderr to an empty string.
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            tracing::warn!(target: "nightcore::oneshot", error = %e, "could not spawn `claude` for one-shot generation; falling back");
        })
        .ok()?;

    // Feed stdin + drain stdout (stderr is null → drained to "") + bound the wait via
    // the shared runner core — the same drained-pipe/deadline/kill mechanics the git
    // and gh bounded runners use. The least-privilege spawn above stays bespoke; only
    // the plumbing is shared. Each arm maps to the best-effort fall-back (None).
    match crate::git::run::drain_and_wait(child, Some(stdin_payload.as_bytes()), GEN_TIMEOUT) {
        Ok(Some(out)) if out.status.success() => Some(out.stdout),
        Ok(Some(out)) => {
            tracing::warn!(target: "nightcore::oneshot", code = ?out.status.code(), "`claude` exited non-zero for one-shot generation; falling back");
            None
        }
        Ok(None) => {
            tracing::warn!(target: "nightcore::oneshot", "`claude` one-shot generation timed out; falling back");
            None
        }
        Err(_) => None,
    }
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

    // --- Binary-resolution precedence (issue #18) -------------------------------
    // A predicate closure stands in for the on-disk executable check so these are
    // pure and never touch the filesystem or the process-global env.

    #[test]
    fn override_prefers_agent_path_over_claude_path() {
        // NIGHTCORE_AGENT_PATH wins over NIGHTCORE_CLAUDE_PATH when both resolve.
        assert_eq!(
            choose_oneshot_binary(Some("/agent"), Some("/claude"), |_| true),
            "/agent",
        );
    }

    #[test]
    fn override_falls_back_to_claude_path_when_agent_unset() {
        // New name absent → the legacy NIGHTCORE_CLAUDE_PATH is honored (the alias).
        assert_eq!(
            choose_oneshot_binary(None, Some("/claude"), |_| true),
            "/claude",
        );
    }

    #[test]
    fn empty_agent_path_is_treated_as_unset() {
        // An empty value is not an override — fall through to the legacy name.
        assert_eq!(
            choose_oneshot_binary(Some(""), Some("/claude"), |_| true),
            "/claude",
        );
    }

    #[test]
    fn stale_override_falls_back_to_path_default() {
        // Set but not a real executable → ignore it and use PATH `claude`, so the
        // one-shot still runs (fail-open) rather than spawning a dead path.
        assert_eq!(
            choose_oneshot_binary(Some("/gone"), None, |_| false),
            DEFAULT_ONESHOT_BINARY,
        );
    }

    #[test]
    fn no_override_uses_path_default() {
        // Neither override set → the bare `claude` off PATH (unchanged behavior).
        assert_eq!(
            choose_oneshot_binary(None, None, |_| true),
            DEFAULT_ONESHOT_BINARY
        );
    }

    #[test]
    fn is_truthy_env_matches_engine_semantics() {
        // Mirrors resolve-claude-binary.ts `isTruthyEnv`: truthy unless unset,
        // empty, "0", or "false".
        assert!(!is_truthy_env(None));
        assert!(!is_truthy_env(Some("")));
        assert!(!is_truthy_env(Some("0")));
        assert!(!is_truthy_env(Some("false")));
        assert!(is_truthy_env(Some("1")));
        assert!(is_truthy_env(Some("true")));
        assert!(is_truthy_env(Some("yes")));
    }
}
