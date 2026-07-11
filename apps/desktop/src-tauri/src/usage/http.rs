//! The shared HTTP plumbing for the usage poller: the one `reqwest` client
//! (rustls), the per-fetch outcome taxonomy, and the token-redaction helper.
//!
//! These endpoints are undocumented + reverse-engineered (spec §3.6), so the
//! taxonomy is the contract for how each failure degrades ONE provider row without
//! ever crashing the poller. `redact` is defence-in-depth: NO error string that
//! could reach a log line or a stored `message` may carry a `Bearer …` token or a
//! token-looking substring (spec §3.7).

use std::time::Duration;

use crate::usage::contract::{Credits, RateWindow};

/// Per-request timeout for a usage fetch (spec §3.4b). Bounded so a hung endpoint
/// can't stall a poll batch.
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The default 429 cooldown when the endpoint gives a `Retry-After` we can't parse
/// as integer seconds (e.g. an HTTP-date). Conservative — we skip the provider for
/// this long and keep its last-good windows.
pub(crate) const DEFAULT_COOLDOWN: Duration = Duration::from_secs(60);

/// A parser's pure output: the normalized windows + optional credits for one
/// provider. Not a wire type — the poller folds it into a `ProviderUsage` with the
/// status/timestamps.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ParsedUsage {
    pub(crate) windows: Vec<RateWindow>,
    pub(crate) credits: Option<Credits>,
}

/// The outcome of a single provider fetch. Every non-`Ok` variant maps to a defined
/// [`UsageStatus`](crate::usage::contract::UsageStatus) in the poller — there is no
/// path that panics or blanks the widget.
#[derive(Debug)]
pub(crate) enum FetchError {
    /// No usable credentials on disk → dormant "not connected" row.
    NoCreds,
    /// 401 / expired → re-auth guidance, NO token refresh (spec decision 4).
    Unauthorized,
    /// 429 → cooldown (honor `Retry-After`), keep last-good.
    RateLimited { retry_after: Option<Duration> },
    /// A 4xx/5xx we don't model, or a body we can't parse → dim, keep last-good.
    /// Carries OUR OWN (already-redacted) reason for the row `message`.
    Unsupported(String),
    /// A transient network/timeout/5xx failure → mark stale, keep last-good.
    Transient(String),
}

/// Build the single rustls `reqwest` client used for every usage fetch. rustls is
/// already the tree's TLS (via `tauri-plugin-updater`), so this adds no native-tls /
/// openssl surface. reqwest is built with `rustls-no-provider`, so the `ring` crypto
/// provider (the tree's provider — NEVER aws-lc-rs) must be the process default when
/// the client's TLS config is assembled; installing it here is idempotent (a second
/// install is a no-op error we ignore). A build failure is surfaced as `Transient` so
/// the poller degrades rather than panics.
pub(crate) fn build_client() -> Result<reqwest::Client, FetchError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| FetchError::Transient(redact(&e.to_string())))
}

/// Map a non-2xx HTTP status to a [`FetchError`] (spec §3.4b: `401`→Unauthorized,
/// `403`→Unsupported/scope, `429`→RateLimited, other 4xx→Unsupported, 5xx→Transient).
/// Returns `None` for a 2xx status (the caller proceeds to parse the body).
pub(crate) fn classify_status(status: u16, retry_after: Option<Duration>) -> Option<FetchError> {
    match status {
        200..=299 => None,
        401 => Some(FetchError::Unauthorized),
        403 => Some(FetchError::Unsupported(
            "the CLI token lacks the usage scope (user:profile) — usage is unavailable".to_string(),
        )),
        429 => Some(FetchError::RateLimited { retry_after }),
        400..=499 => Some(FetchError::Unsupported(format!(
            "the usage endpoint returned {status} (unmodeled)"
        ))),
        _ => Some(FetchError::Transient(format!(
            "the usage endpoint returned {status}"
        ))),
    }
}

/// Parse a `Retry-After` header value into a cooldown [`Duration`]. Integer seconds
/// are honored exactly; an HTTP-date (which we do not parse without a date crate)
/// falls back to [`DEFAULT_COOLDOWN`]. `None` when the header is absent.
pub(crate) fn parse_retry_after(header: Option<&str>) -> Option<Duration> {
    let raw = header?.trim();
    if raw.is_empty() {
        return Some(DEFAULT_COOLDOWN);
    }
    match raw.parse::<u64>() {
        Ok(secs) => Some(Duration::from_secs(secs.min(3600))),
        // An HTTP-date form — honor it as a fixed conservative cooldown.
        Err(_) => Some(DEFAULT_COOLDOWN),
    }
}

/// Strip anything token-shaped from a string before it can reach a log line or a
/// stored `message` (spec §3.7). Redacts: the word after a `Bearer`, and any token
/// starting with a known secret prefix (`sk-ant-` Claude OAuth, `eyJ` JWT) or that
/// is a long opaque run. Whitespace is normalized to single spaces — acceptable for
/// a log/diagnostic string.
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

/// Whether a whitespace-delimited token looks like credential material: a known
/// OAuth/JWT prefix, or a long opaque alphanumeric run (defence-in-depth). Judges the
/// value side of a `key=value` pair (so `token=eyJ…` / `ChatGPT-Account-Id=…` redact)
/// and trims surrounding punctuation so `Bearer(sk-ant-…)` / trailing commas redact.
fn looks_secret(tok: &str) -> bool {
    // For a `key=value` token, judge the value (the part after the last `=`).
    let candidate = tok.rsplit('=').next().unwrap_or(tok);
    let t = candidate.trim_matches(|c: char| !c.is_alphanumeric());
    if t.len() < 12 {
        return false;
    }
    if t.starts_with("sk-ant-") || t.starts_with("eyJ") {
        return true;
    }
    // A long run of URL-safe base64-ish characters with no spaces is almost never
    // legitimate diagnostic prose — redact it.
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
    fn classify_status_maps_the_documented_codes() {
        assert!(classify_status(200, None).is_none());
        assert!(matches!(
            classify_status(401, None),
            Some(FetchError::Unauthorized)
        ));
        assert!(matches!(
            classify_status(403, None),
            Some(FetchError::Unsupported(_))
        ));
        assert!(matches!(
            classify_status(429, Some(Duration::from_secs(30))),
            Some(FetchError::RateLimited { .. })
        ));
        assert!(matches!(
            classify_status(418, None),
            Some(FetchError::Unsupported(_))
        ));
        assert!(matches!(
            classify_status(503, None),
            Some(FetchError::Transient(_))
        ));
    }

    #[test]
    fn retry_after_parses_seconds_and_falls_back_on_a_date() {
        assert_eq!(parse_retry_after(Some("30")), Some(Duration::from_secs(30)));
        assert_eq!(parse_retry_after(None), None);
        // A capped ceiling so a hostile header can't park a provider for a day.
        assert_eq!(
            parse_retry_after(Some("99999")),
            Some(Duration::from_secs(3600))
        );
        // An HTTP-date form falls back to the conservative default cooldown.
        assert_eq!(
            parse_retry_after(Some("Wed, 21 Oct 2026 07:28:00 GMT")),
            Some(DEFAULT_COOLDOWN)
        );
    }
}
