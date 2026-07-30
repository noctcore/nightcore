//! Small, dependency-free text helpers shared across tiers.
//!
//! Lives in `infra` (rank 2) so leaf/engine callers can depend DOWNWARD on it
//! instead of reaching sideways into an engine module for a string utility.
//! [`tail_output`] was hoisted here from `workflow::gauntlet::run` (issue #17
//! phase A.3): the gauntlet, the Structure-Lock gauntlet, and `worktree`
//! provisioning all truncate subprocess output identically, and `worktree`
//! (rank 3) must not import the rank-5 workflow tier for it.

/// How much of a failing step's output to retain for the UI. Bounded so a noisy
/// failure can't bloat the event payload; truncated from the tail (the part that
/// usually names the failure).
const TAIL_LIMIT: usize = 4000;

/// Combine stdout+stderr and keep the last [`TAIL_LIMIT`] bytes (the part that
/// usually names the failure), as UTF-8-lossy text. Shared by the gauntlet, the
/// Structure-Lock gauntlet (`gauntlet_project`), and worktree provisioning so
/// every gate truncates identically.
pub(crate) fn tail_output(stdout: &[u8], stderr: &[u8]) -> String {
    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(stdout));
    if !stderr.is_empty() {
        combined.push('\n');
        combined.push_str(&String::from_utf8_lossy(stderr));
    }
    if combined.len() > TAIL_LIMIT {
        let start = combined.len() - TAIL_LIMIT;
        // Snap to a char boundary so we never slice mid-codepoint.
        let start = (start..combined.len())
            .find(|&i| combined.is_char_boundary(i))
            .unwrap_or(combined.len());
        format!("…{}", &combined[start..])
    } else {
        combined
    }
}

/// Strip anything token-shaped from a string before it can reach a log line, a
/// stored `message`, or an append-only journal entry. Redacts: the word after a
/// `Bearer`, any token starting with a known provider/JWT prefix
/// ([`SECRET_PREFIXES`] — GitHub `ghp_`/…, OpenAI/Claude `sk-…`, Slack `xox…`,
/// `eyJ` JWT) with a non-trivial body, and any long opaque run. Whitespace is
/// normalized to single spaces — acceptable for a log/diagnostic string.
///
/// Lives in `infra` (rank 1) rather than beside its first caller because two tiers
/// now need it: the usage poller's fail-soft diagnostics (`usage::http`, which
/// re-exports it) and the per-project governance journal
/// (`store::governance`), which must never persist credential material. A second
/// implementation would be free to disagree about what a secret looks like.
pub(crate) fn redact(input: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut redact_next = false;
    for tok in input.split_whitespace() {
        if redact_next {
            out.push("<redacted>".to_string());
            redact_next = false;
            continue;
        }
        // Case-insensitive `Bearer` so `Authorization: Bearer x` is caught either way.
        if tok.eq_ignore_ascii_case("bearer") {
            out.push(tok.to_string());
            redact_next = true;
            continue;
        }
        if looks_secret(tok) {
            out.push("<redacted>".to_string());
        } else {
            out.push(tok.to_string());
        }
    }
    out.join(" ")
}

/// Known credential prefixes for the providers Nightcore's diagnostics may touch:
/// OpenAI/Claude API keys (`sk-…`, incl. `sk-ant-…`), the GitHub token family
/// (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`), Slack tokens (`xoxb-`/`xoxp-`/
/// `xoxa-`/`xoxr-`), and JWTs (the `eyJ` base64url header). A token beginning with any
/// of these is treated as a secret once it carries at least
/// [`MIN_PREFIXED_SECRET_BODY`] chars of body — far below the ≥24 opaque-run rule,
/// which on its own missed a short prefixed token like a ~20-char `ghp_…` (#224).
const SECRET_PREFIXES: &[&str] = &[
    "sk-",         // OpenAI + Claude (`sk-ant-…`) API keys
    "ghp_",        // GitHub personal access token
    "gho_",        // GitHub OAuth token
    "ghu_",        // GitHub user-to-server token
    "ghs_",        // GitHub server-to-server token
    "ghr_",        // GitHub refresh token
    "github_pat_", // GitHub fine-grained PAT
    "xoxb-",       // Slack bot token
    "xoxp-",       // Slack user token
    "xoxa-",       // Slack app-level token
    "xoxr-",       // Slack refresh token
    "eyJ",         // JWT header (`{"…` base64url-encoded)
];

/// Minimum secret-body length after a known [`SECRET_PREFIXES`] entry for a token to
/// count as credential material — low enough to catch a short prefixed token that the
/// ≥24 opaque-run rule misses, high enough that a bare `sk-` / `eyJ` word in prose
/// does not trip.
const MIN_PREFIXED_SECRET_BODY: usize = 8;

/// Whether a whitespace-delimited token looks like credential material: a known
/// provider/JWT prefix followed by a non-trivial body, or a long opaque alphanumeric
/// run (defence-in-depth). Judges the value side of a `key=value` pair (so
/// `token=eyJ…` / `ChatGPT-Account-Id=…` redact) and trims surrounding punctuation so
/// `Bearer(sk-ant-…)` / trailing commas redact.
fn looks_secret(tok: &str) -> bool {
    // For a `key=value` token, judge the value (the part after the last `=`).
    let candidate = tok.rsplit('=').next().unwrap_or(tok);
    let t = candidate.trim_matches(|c: char| !c.is_alphanumeric());
    // A known provider/JWT prefix with a non-trivial body — catches SHORT prefixed
    // tokens (e.g. a ~20-char `ghp_…`) that the opaque-run rule below misses because
    // they are under 24 chars.
    for prefix in SECRET_PREFIXES {
        if let Some(body) = t.strip_prefix(prefix) {
            if body.len() >= MIN_PREFIXED_SECRET_BODY {
                return true;
            }
        }
    }
    // For an UNKNOWN token: a long run of URL-safe base64-ish characters with no
    // spaces is almost never legitimate diagnostic prose — redact it.
    t.len() >= 24
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_strips_a_bearer_token() {
        let line = "request failed: Authorization: Bearer sk-ant-oat01-SECRETVALUE12345 (401)";
        let red = redact(line);
        assert!(
            !red.contains("sk-ant-oat01-SECRETVALUE12345"),
            "token leaked: {red}"
        );
        assert!(
            red.contains("Bearer"),
            "the word Bearer is fine to keep: {red}"
        );
        assert!(red.contains("<redacted>"));
    }

    #[test]
    fn redact_strips_a_jwt_and_a_long_opaque_run() {
        let jwt = "eyJhbGciOiJI.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4fwpM";
        let opaque = "AKIAIOSFODNN7EXAMPLEabcdEFGH";
        let red = redact(&format!("codex token={jwt} key={opaque} ok"));
        assert!(!red.contains(jwt), "jwt leaked: {red}");
        assert!(!red.contains(opaque), "opaque secret leaked: {red}");
        assert!(red.contains("ok"), "prose survives: {red}");
    }

    #[test]
    fn redact_keeps_ordinary_prose() {
        let line = "the usage endpoint returned 500";
        assert_eq!(
            redact(line),
            line,
            "short ordinary words are never redacted"
        );
    }

    #[test]
    fn redact_strips_short_prefixed_provider_tokens() {
        // #224: a ~20-char `ghp_…` PAT is under the 24-char opaque-run threshold and
        // is not `sk-ant-`/`eyJ`, so it previously leaked. It must now redact — and a
        // GitHub OAuth `gho_` token and a Slack `xoxb-` token alongside it.
        let ghp = "ghp_ABCdef0123456789klmn"; // full-length PAT
        let short_ghp = "ghp_ABCdef0123456"; // ~17 chars — under the old ≥24 opaque-run rule, the regression case
        let gho = "gho_16C7e42F292c6912E7710c838347Ae178B4a";
        let slack = "xoxb-1234-5678-abcdEFGHijklMNOP";
        let red = redact(&format!(
            "gh push failed token={short_ghp} also {ghp} {gho} {slack} ok"
        ));
        assert!(!red.contains(short_ghp), "short ghp leaked: {red}");
        assert!(!red.contains(ghp), "ghp leaked: {red}");
        assert!(!red.contains(gho), "gho leaked: {red}");
        assert!(!red.contains(slack), "slack token leaked: {red}");
        assert!(red.contains("ok"), "prose survives: {red}");
    }

    #[test]
    fn looks_secret_covers_prefixes_and_still_redacts_the_old_cases() {
        // New: short prefixed provider tokens.
        assert!(looks_secret("ghp_ABCdef0123456"));
        assert!(looks_secret("github_pat_11ABCDEFG0abcdefghij"));
        assert!(looks_secret("sk-ant-oat01-SECRETVALUE12345"));
        assert!(looks_secret("xoxb-1234-5678-abcdEFGH"));
        // key=value form judges the value side.
        assert!(looks_secret("token=ghp_ABCdef0123456"));
        // Still redacts the pre-existing cases: a JWT and a long opaque run.
        assert!(looks_secret(
            "eyJhbGciOiJI.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4fwpM"
        ));
        assert!(looks_secret("AKIAIOSFODNN7EXAMPLEabcdEFGH"));
        // A bare prefix with too little body, and ordinary prose, are NOT secrets.
        assert!(!looks_secret("sk-"));
        assert!(!looks_secret("returned"));
        assert!(!looks_secret("500"));
    }

    /// A repo-relative PATH is not credential material: the opaque-run rule only
    /// fires on tokens made of `[A-Za-z0-9._-]`, and a `/` disqualifies the whole
    /// token. Pins that the governance journal can record quarantined paths verbatim.
    #[test]
    fn redact_keeps_repo_relative_paths() {
        let line = "docs/research/2026-07-11-roadmap-v0.3-v0.5.md";
        assert_eq!(redact(line), line, "a path with separators survives");
    }

    #[test]
    fn combines_streams_and_passes_short_output_through() {
        assert_eq!(tail_output(b"out", b"err"), "out\nerr");
        assert_eq!(tail_output(b"out", b""), "out");
    }

    #[test]
    fn truncates_from_the_tail_on_a_char_boundary() {
        // A payload longer than the limit keeps only the tail, prefixed with '…',
        // and never slices mid-codepoint.
        let big = "é".repeat(TAIL_LIMIT); // 2 bytes each ⇒ well over the limit
        let out = tail_output(big.as_bytes(), b"");
        assert!(out.starts_with('…'), "truncated output is tail-marked");
        assert!(out.len() <= TAIL_LIMIT + '…'.len_utf8() + 1);
        // Every retained byte is valid UTF-8 (no mid-codepoint slice).
        assert!(out.chars().skip(1).all(|c| c == 'é'));
    }
}
