//! Codex usage fetch + parser (spec §3.4c / §3.5).
//!
//! `GET https://chatgpt.com/backend-api/wham/usage` with the OAuth bearer + the
//! `ChatGPT-Account-Id` header. The body carries a `rate_limit` with a
//! `primary_window` (5h/session lane) + `secondary_window` (weekly), plus
//! `additional_rate_limits[]` (model-scoped) and a `credits` block. Reset instants
//! are epoch-seconds → ISO-8601 via the shared `infra::time` helper (no `chrono`).
//! Every field is read leniently: a missing field skips that window, never a panic.

use serde_json::Value;

use crate::infra::time::iso8601_utc_from_secs;
use crate::usage::contract::{Credits, RateWindow};
use crate::usage::credentials::read_codex_creds;
use crate::usage::http::{classify_status, parse_retry_after, redact, FetchError, ParsedUsage};

/// The reverse-engineered Codex usage endpoint.
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
/// A Codex CLI-flavored User-Agent.
const CODEX_USER_AGENT: &str = "codex-cli/nightcore";

/// Fetch + parse Codex usage. Reads the token + account id at call time and drops
/// them when the request returns (spec §3.7). Status mapping per spec §3.4c.
pub(crate) async fn fetch(client: &reqwest::Client) -> Result<ParsedUsage, FetchError> {
    let creds = read_codex_creds()?;
    let resp = client
        .get(CODEX_USAGE_URL)
        .header("Authorization", format!("Bearer {}", creds.access_token))
        .header("ChatGPT-Account-Id", creds.account_id.as_str())
        .header("Accept", "application/json")
        .header("User-Agent", CODEX_USER_AGENT)
        .send()
        .await
        .map_err(|e| FetchError::Transient(redact(&e.to_string())))?;

    let status = resp.status().as_u16();
    let retry_after = parse_retry_after(
        resp.headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok()),
    );
    if let Some(err) = classify_status(status, retry_after) {
        return Err(err);
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| FetchError::Unsupported(redact(&e.to_string())))?;
    Ok(parse_codex(&body))
}

/// Parse a Codex `wham/usage` body into normalized windows + credits.
pub(crate) fn parse_codex(v: &Value) -> ParsedUsage {
    let mut windows = Vec::new();
    if let Some(rl) = v.get("rate_limit") {
        if let Some(w) = parse_window(rl.get("primary_window"), "5h", "Session (5h)", None) {
            windows.push(w);
        }
        if let Some(w) = parse_window(rl.get("secondary_window"), "weekly", "Weekly", None) {
            windows.push(w);
        }
    }
    if let Some(extra) = v.get("additional_rate_limits").and_then(Value::as_array) {
        for (i, item) in extra.iter().enumerate() {
            let model = item
                .get("model")
                .or_else(|| item.get("id"))
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let (kind, label, scope) = match model {
                Some(id) => (format!("model:{id}"), id.to_string(), Some(id.to_string())),
                None => (format!("extra_{i}"), "Additional limit".to_string(), None),
            };
            if let Some(w) = parse_window(Some(item), &kind, &label, scope) {
                windows.push(w);
            }
        }
    }
    ParsedUsage {
        windows,
        credits: parse_credits(v.get("credits")),
    }
}

/// Parse one Codex window object (`{ used_percent, reset_at | resets_in_seconds,
/// limit_window_seconds }`) into a `RateWindow`. `None` when there is no numeric
/// `used_percent` (not a renderable window).
fn parse_window(
    v: Option<&Value>,
    kind: &str,
    label: &str,
    scope_model: Option<String>,
) -> Option<RateWindow> {
    let obj = v?;
    let used_percent = obj.get("used_percent").and_then(Value::as_f64)?;
    Some(RateWindow {
        kind: kind.to_string(),
        label: label.to_string(),
        used_percent: used_percent.clamp(0.0, 100.0),
        resets_at: reset_instant(obj),
        window_seconds: obj.get("limit_window_seconds").and_then(Value::as_u64),
        scope_model,
    })
}

/// Resolve a window's reset instant: an absolute `reset_at` epoch-seconds when
/// present, else a relative `resets_in_seconds` from now. `None` when neither is a
/// usable number.
fn reset_instant(obj: &Value) -> Option<String> {
    if let Some(secs) = obj.get("reset_at").and_then(Value::as_i64) {
        return iso8601_utc_from_secs(secs);
    }
    if let Some(rel) = obj.get("resets_in_seconds").and_then(Value::as_i64) {
        let now_secs = (crate::task::now_ms() / 1000) as i64;
        return iso8601_utc_from_secs(now_secs + rel);
    }
    None
}

/// Parse Codex `credits { has_credits, unlimited, balance }` into `Credits`.
fn parse_credits(v: Option<&Value>) -> Option<Credits> {
    let c = v?;
    if !c.is_object() {
        return None;
    }
    let has_credits = c.get("has_credits").and_then(Value::as_bool);
    let unlimited = c.get("unlimited").and_then(Value::as_bool);
    let balance = c.get("balance").and_then(Value::as_f64);
    if has_credits.is_none() && unlimited.is_none() && balance.is_none() {
        return None;
    }
    Some(Credits {
        has_credits,
        unlimited,
        balance,
        currency: c
            .get("currency")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_primary_secondary_and_additional_windows() {
        let body = serde_json::json!({
            "rate_limit": {
                "primary_window":   { "used_percent": 30, "reset_at": 1_700_000_000,
                                      "limit_window_seconds": 18000 },
                "secondary_window": { "used_percent": 65, "reset_at": 1_700_600_000,
                                      "limit_window_seconds": 604800 }
            },
            "additional_rate_limits": [
                { "model": "gpt-5-codex", "used_percent": 12, "reset_at": 1_700_000_000,
                  "limit_window_seconds": 86400 }
            ],
            "credits": { "has_credits": true, "unlimited": false, "balance": 4.5 }
        });
        let parsed = parse_codex(&body);
        assert_eq!(parsed.windows.len(), 3);

        let five = parsed
            .windows
            .iter()
            .find(|w| w.kind == "5h")
            .expect("primary");
        assert_eq!(five.used_percent, 30.0);
        assert_eq!(five.window_seconds, Some(18_000));
        // reset_at epoch-seconds → ISO-8601 (the shared civil-time formatter).
        assert_eq!(five.resets_at.as_deref(), Some("2023-11-14T22:13:20Z"));

        let weekly = parsed.windows.iter().find(|w| w.kind == "weekly").unwrap();
        assert_eq!(weekly.used_percent, 65.0);

        let model = parsed
            .windows
            .iter()
            .find(|w| w.kind == "model:gpt-5-codex")
            .expect("additional model window");
        assert_eq!(model.scope_model.as_deref(), Some("gpt-5-codex"));
        assert_eq!(model.used_percent, 12.0);

        let credits = parsed.credits.expect("credits present");
        assert_eq!(credits.has_credits, Some(true));
        assert_eq!(credits.unlimited, Some(false));
        assert_eq!(credits.balance, Some(4.5));
    }

    #[test]
    fn relative_reset_seconds_is_supported_when_absolute_absent() {
        let body = serde_json::json!({
            "rate_limit": { "primary_window": { "used_percent": 10, "resets_in_seconds": 3600 } }
        });
        let parsed = parse_codex(&body);
        assert_eq!(parsed.windows.len(), 1);
        // A relative reset resolves to an ISO instant (exact value depends on now,
        // so we assert only that it produced a Z-suffixed timestamp).
        assert!(parsed.windows[0]
            .resets_at
            .as_deref()
            .is_some_and(|s| s.ends_with('Z')));
    }

    #[test]
    fn garbage_and_empty_bodies_never_panic() {
        for body in [
            serde_json::json!({}),
            serde_json::json!({ "rate_limit": {} }),
            serde_json::json!({ "rate_limit": { "primary_window": { "used_percent": "nope" } } }),
            serde_json::json!({ "additional_rate_limits": "not an array" }),
            serde_json::json!(null),
        ] {
            let parsed = parse_codex(&body);
            assert!(
                parsed.windows.is_empty(),
                "unparseable body → empty windows"
            );
            assert!(parsed.credits.is_none());
        }
    }
}
