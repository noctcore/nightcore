//! Claude usage fetch + parser (spec §3.4b / §3.5).
//!
//! `GET https://api.anthropic.com/api/oauth/usage` behind the `anthropic-beta:
//! oauth-2025-04-20` flag, with the Claude Code CLI User-Agent. The parser handles
//! BOTH live response shapes (the migration already happened once, so both are in
//! the wild): the legacy flat keys (`five_hour`/`seven_day_*`) AND the newer
//! `limits[]` array — preferring `limits[]` when present. Every field is read
//! leniently: a missing/renamed field skips that window, never a panic (spec §3.6).

use serde_json::Value;

use crate::usage::contract::{Credits, RateWindow};
use crate::usage::credentials::read_claude_creds;
use crate::usage::http::{classify_status, parse_retry_after, redact, FetchError, ParsedUsage};

/// The reverse-engineered OAuth usage endpoint.
const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// Deliberately the Claude Code CLI User-Agent (the endpoint is gated to it). A
/// pinned fallback version — we don't shell out to detect the installed CLI.
const CLAUDE_USER_AGENT: &str = "claude-code/2.1.0";

/// Fetch + parse Claude usage. Reads the OAuth token at call time and drops it when
/// the request returns (spec §3.7). Status mapping per spec §3.4b.
pub(crate) async fn fetch(client: &reqwest::Client) -> Result<ParsedUsage, FetchError> {
    let creds = read_claude_creds()?;
    let resp = client
        .get(CLAUDE_USAGE_URL)
        .header("Authorization", format!("Bearer {}", creds.access_token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("Accept", "application/json")
        .header("User-Agent", CLAUDE_USER_AGENT)
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
    Ok(parse_claude(&body))
}

/// Parse a Claude usage body into normalized windows + credits. Prefers the newer
/// `limits[]` array; falls through to the legacy flat keys when it's absent/empty.
/// An org-managed/education body with NO numeric windows yields EMPTY windows —
/// NEVER a fabricated `%` from spend (spec §3.5 guard #1808).
pub(crate) fn parse_claude(v: &Value) -> ParsedUsage {
    let windows = match v.get("limits").and_then(Value::as_array) {
        Some(limits) if !limits.is_empty() => parse_limits(limits),
        _ => parse_flat(v),
    };
    ParsedUsage {
        windows,
        credits: parse_extra_usage(v),
    }
}

/// Parse the newer `limits[]` array: each element `{ kind, percent, resets_at,
/// scope.model.{id,display_name}, is_active, limit_window_seconds }`. Model-scoped
/// windows key off `scope.model.id`. An explicitly inactive promo window is skipped.
fn parse_limits(limits: &[Value]) -> Vec<RateWindow> {
    let mut out = Vec::new();
    for item in limits {
        // Skip an explicitly inactive (promotional / not-currently-applicable) window.
        if item.get("is_active").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let Some(percent) = item.get("percent").and_then(Value::as_f64) else {
            continue; // no numeric utilization → not a window we can render
        };
        let model = item.get("scope").and_then(|s| s.get("model"));
        let model_id = model
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let model_display = model
            .and_then(|m| m.get("display_name"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let raw_kind = item.get("kind").and_then(Value::as_str).unwrap_or("");

        let (kind, label) = match model_id {
            Some(id) => (
                format!("model:{id}"),
                model_display
                    .map(|d| format!("{d} weekly"))
                    .unwrap_or_else(|| humanize_kind(raw_kind)),
            ),
            None => (map_kind(raw_kind), humanize_kind(raw_kind)),
        };
        out.push(RateWindow {
            kind,
            label,
            used_percent: normalize_pct(percent),
            resets_at: reset_value(item.get("resets_at")),
            window_seconds: item
                .get("limit_window_seconds")
                .and_then(Value::as_u64)
                .or_else(|| window_seconds_for_kind(raw_kind)),
            scope_model: model_display.map(str::to_string),
        });
    }
    out
}

/// Parse the legacy flat keys (`five_hour`, `seven_day`, `seven_day_opus`,
/// `seven_day_sonnet`), each `{ utilization, resets_at }`.
fn parse_flat(v: &Value) -> Vec<RateWindow> {
    const LANES: &[(&str, &str, &str, Option<&str>)] = &[
        ("five_hour", "5h", "Session (5h)", None),
        ("seven_day", "weekly", "Weekly", None),
        ("seven_day_opus", "weekly_opus", "Opus weekly", Some("Opus")),
        (
            "seven_day_sonnet",
            "weekly_sonnet",
            "Sonnet weekly",
            Some("Sonnet"),
        ),
    ];
    let mut out = Vec::new();
    for (src_key, kind, label, scope) in LANES {
        let Some(lane) = v.get(src_key) else { continue };
        let Some(util) = lane.get("utilization").and_then(Value::as_f64) else {
            continue;
        };
        out.push(RateWindow {
            kind: kind.to_string(),
            label: label.to_string(),
            used_percent: normalize_pct(util),
            resets_at: reset_value(lane.get("resets_at")),
            window_seconds: window_seconds_for_kind(src_key),
            scope_model: scope.map(str::to_string),
        });
    }
    out
}

/// Parse `extra_usage { used_credits, currency, is_enabled }` into `Credits`. Claude
/// `extra_usage` amounts are MINOR currency units — divide by 100 (research #1114).
fn parse_extra_usage(v: &Value) -> Option<Credits> {
    let eu = v.get("extra_usage")?;
    if !eu.is_object() {
        return None;
    }
    let balance = eu
        .get("used_credits")
        .and_then(Value::as_f64)
        .map(|minor| minor / 100.0);
    let has_credits = eu.get("is_enabled").and_then(Value::as_bool);
    let currency = eu
        .get("currency")
        .and_then(Value::as_str)
        .map(str::to_string);
    // Nothing meaningful → no credits row.
    if balance.is_none() && has_credits.is_none() && currency.is_none() {
        return None;
    }
    Some(Credits {
        has_credits,
        unlimited: None,
        balance,
        currency,
    })
}

/// Normalize a Claude utilization to `0..=100`: a value `<= 1.0` is a fraction
/// (multiply by 100), otherwise it is already a percent. Clamped to `0..=100`.
fn normalize_pct(raw: f64) -> f64 {
    let pct = if raw <= 1.0 { raw * 100.0 } else { raw };
    pct.clamp(0.0, 100.0)
}

/// `resets_at` may be an ISO string (Claude's usual shape) or an epoch-seconds
/// number — accept both, else `None`.
fn reset_value(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => n
            .as_i64()
            .and_then(crate::infra::time::iso8601_utc_from_secs),
        _ => None,
    }
}

/// A stable machine key for a legacy/limits `kind` string.
fn map_kind(raw: &str) -> String {
    match raw {
        "five_hour" => "5h".to_string(),
        "seven_day" => "weekly".to_string(),
        "" => "weekly".to_string(),
        other => other.to_string(),
    }
}

/// A human display label for a `kind` string when no model display name is given.
fn humanize_kind(raw: &str) -> String {
    match raw {
        "five_hour" => "Session (5h)".to_string(),
        "seven_day" => "Weekly".to_string(),
        "seven_day_opus" => "Opus weekly".to_string(),
        "seven_day_sonnet" => "Sonnet weekly".to_string(),
        "" => "Weekly".to_string(),
        other => other.replace('_', " "),
    }
}

/// The nominal window length for a known lane key (Claude omits it on the flat
/// shape); `None` for an unknown key.
fn window_seconds_for_kind(raw: &str) -> Option<u64> {
    match raw {
        "five_hour" => Some(18_000),
        k if k.starts_with("seven_day") => Some(604_800),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_legacy_flat_shape_and_normalizes_fractions() {
        // Legacy: utilization as a 0..1 fraction + explicit percent both land as 0..100.
        let body = serde_json::json!({
            "five_hour":   { "utilization": 0.42, "resets_at": "2026-07-11T05:00:00Z" },
            "seven_day":   { "utilization": 73.0, "resets_at": "2026-07-18T00:00:00Z" },
            "seven_day_opus": { "utilization": 0.9, "resets_at": "2026-07-18T00:00:00Z" }
        });
        let parsed = parse_claude(&body);
        let five = parsed
            .windows
            .iter()
            .find(|w| w.kind == "5h")
            .expect("5h window");
        assert!((five.used_percent - 42.0).abs() < 1e-9, "0.42 → 42%");
        assert_eq!(five.label, "Session (5h)");
        assert_eq!(five.window_seconds, Some(18_000));
        let weekly = parsed.windows.iter().find(|w| w.kind == "weekly").unwrap();
        assert!((weekly.used_percent - 73.0).abs() < 1e-9, "73.0 stays 73%");
        assert_eq!(weekly.window_seconds, Some(604_800));
        let opus = parsed
            .windows
            .iter()
            .find(|w| w.kind == "weekly_opus")
            .unwrap();
        assert_eq!(opus.scope_model.as_deref(), Some("Opus"));
        assert!((opus.used_percent - 90.0).abs() < 1e-9);
    }

    #[test]
    fn prefers_the_limits_array_when_present() {
        // Both shapes present: `limits[]` wins, and a model-scoped window keys off
        // scope.model.id + carries the display name.
        let body = serde_json::json!({
            "five_hour": { "utilization": 0.1, "resets_at": "2026-07-11T05:00:00Z" },
            "limits": [
                { "kind": "five_hour", "percent": 55, "resets_at": "2026-07-11T05:00:00Z" },
                { "kind": "seven_day", "percent": 0.2, "resets_at": "2026-07-18T00:00:00Z",
                  "scope": { "model": { "id": "claude-opus-4-8", "display_name": "Opus" } },
                  "limit_window_seconds": 604800, "is_active": true }
            ]
        });
        let parsed = parse_claude(&body);
        // The flat 5h (10%) is IGNORED — the limits[] 5h (55%) wins.
        let five = parsed
            .windows
            .iter()
            .find(|w| w.kind == "5h")
            .expect("limits 5h");
        assert!(
            (five.used_percent - 55.0).abs() < 1e-9,
            "limits[] preferred: {}",
            five.used_percent
        );
        let opus = parsed
            .windows
            .iter()
            .find(|w| w.kind == "model:claude-opus-4-8")
            .expect("model-scoped window");
        assert_eq!(opus.scope_model.as_deref(), Some("Opus"));
        assert_eq!(opus.label, "Opus weekly");
        assert!(
            (opus.used_percent - 20.0).abs() < 1e-9,
            "0.2 fraction → 20%"
        );
        assert_eq!(opus.window_seconds, Some(604_800));
    }

    #[test]
    fn skips_an_inactive_limits_window() {
        let body = serde_json::json!({
            "limits": [
                { "kind": "seven_day", "percent": 40, "is_active": true },
                { "kind": "promo", "percent": 0, "is_active": false }
            ]
        });
        let parsed = parse_claude(&body);
        assert_eq!(
            parsed.windows.len(),
            1,
            "the inactive promo window is dropped"
        );
        assert_eq!(parsed.windows[0].kind, "weekly");
    }

    #[test]
    fn extra_usage_minor_units_divide_by_100() {
        // Research #1114: extra_usage amounts are MINOR units → /100 into a balance.
        let body = serde_json::json!({
            "five_hour": { "utilization": 0.5 },
            "extra_usage": { "used_credits": 1250, "currency": "USD", "is_enabled": true }
        });
        let credits = parse_claude(&body).credits.expect("credits present");
        assert_eq!(credits.balance, Some(12.5), "1250 minor units → $12.50");
        assert_eq!(credits.currency.as_deref(), Some("USD"));
        assert_eq!(credits.has_credits, Some(true));
    }

    #[test]
    fn org_managed_body_with_no_numeric_windows_yields_empty_not_fake_percent() {
        // Guard #1808: an org-managed/education body with no numeric windows must
        // NOT derive a fabricated `%` from spend — empty windows, no credits.
        let body = serde_json::json!({
            "organization": { "managed": true },
            "extra_usage": { "is_enabled": false }
        });
        let parsed = parse_claude(&body);
        assert!(parsed.windows.is_empty(), "no fabricated windows");
        assert_eq!(parsed.credits.and_then(|c| c.has_credits), Some(false));
    }

    #[test]
    fn garbage_and_empty_bodies_never_panic() {
        for body in [
            serde_json::json!({}),
            serde_json::json!({ "limits": [] }),
            serde_json::json!({ "limits": "not an array" }),
            serde_json::json!({ "five_hour": { "utilization": "nope" } }),
            serde_json::json!(null),
        ] {
            let parsed = parse_claude(&body);
            assert!(
                parsed.windows.is_empty(),
                "unparseable body → empty windows"
            );
        }
    }
}
