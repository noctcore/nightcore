//! The provider usage-meter wire contract (issue #121). Rust-authored — the poller
//! mints these from reverse-engineered provider responses — so they follow the
//! `TrustReport` codegen discipline (NOT the zod-first path): `Serialize` +
//! `Deserialize` + a `cfg(test)`-gated `TS` derive that `cargo test` exports into
//! `apps/web/src/lib/generated/`. Registered in `bindings/export.rs` beside the
//! `TrustReport` cluster; never hand-edit the generated files.
//!
//! SECURITY (spec §3.7): NONE of these shapes carry credential material. The
//! `UsageMeter` held in managed state and pushed over `nc:usage` contains only
//! windows / credits / status / timestamps; tokens are read at poll time and
//! dropped when the request returns. `message` is always OUR OWN trusted text
//! (re-auth guidance, a degraded reason) — never a raw endpoint body — so the web
//! renders it without an untrusted-content concern.

use serde::{Deserialize, Serialize};
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

// The popover cost scan reuses the Trust Report's token totals verbatim (spec §3.1)
// — one ts-rs type for "tokens summed across local session logs", not two.
use crate::workflow::trust::TokenTotals;

/// The whole-meter snapshot the web polls + the `nc:usage` push carries. One row
/// per configured provider, ALWAYS present (a not-connected provider is a dormant
/// row, never absent — so the widget layout is stable). Minted per poll, held in
/// managed state; NEVER persisted with credentials (spec §3.7).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "UsageMeter.ts"))]
pub struct UsageMeter {
    /// `claude`, `codex` — stable order (the widget renders them in this order).
    pub providers: Vec<ProviderUsage>,
    /// ISO-8601 of the last poll that touched ANY provider (the whole-meter
    /// freshness stamp). `None` before the first poll.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub updated_at: Option<String>,
}

/// One provider's usage row. Always present in the meter (a dormant "not connected"
/// row when there are no credentials on disk) so the layout is stable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "ProviderUsage.ts"))]
pub struct ProviderUsage {
    /// `"claude"` | `"codex"` — the provider-name vocabulary shared with
    /// `provider::CLAUDE_PROVIDER_ID` etc.
    pub provider: String,
    /// The degraded-state machine — drives every UI affordance (spec §3.6).
    pub status: UsageStatus,
    /// The first-class metric (spec decision 1): rate-limit windows. Empty for a
    /// dormant / unauthorized / unsupported row.
    #[serde(default)]
    pub windows: Vec<RateWindow>,
    /// Popover-only extra-credit / balance info (Codex `credits`, Claude
    /// `extra_usage`). `None` when the provider carries none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub credits: Option<Credits>,
    /// ISO-8601 of THIS provider's last SUCCESSFUL fetch (`None` if never).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub updated_at: Option<String>,
    /// `true` when showing last-good windows after a failed refresh (spec decision
    /// 4) — the web dims the bar + tooltips "last updated …".
    #[serde(default)]
    pub stale: bool,
    /// Re-auth guidance / a degraded reason. OUR OWN trusted text (never an echoed
    /// endpoint body). `None` on a healthy row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub message: Option<String>,
    // NOTE: cost is NOT here. It is computed on popover open by a separate command
    // (`get_usage_cost`, spec §3.8), never on the 10-min poll, so the hot path
    // stays network-only.
}

impl ProviderUsage {
    /// A dormant "not connected" row for `provider` — the shape a provider with no
    /// credentials on disk renders (never an error, never a spinner; spec decision
    /// 3). Also the starting shape before the first poll.
    pub(crate) fn not_connected(provider: &str) -> Self {
        Self {
            provider: provider.to_string(),
            status: UsageStatus::NotConnected,
            windows: Vec::new(),
            credits: None,
            updated_at: None,
            stale: false,
            message: None,
        }
    }

    /// A disabled row (the meter is opt-in-off; spec decision 5) — the whole widget
    /// renders its "Enable usage meter" state, so per-row content is empty.
    pub(crate) fn disabled(provider: &str) -> Self {
        Self {
            status: UsageStatus::Disabled,
            ..Self::not_connected(provider)
        }
    }
}

/// One rate-limit window: the utilization + reset for a lane (session / weekly /
/// model-scoped). `used_percent` is NORMALIZED to `0..=100` at parse time (spec
/// §3.5) so the web never has to know a provider's raw units.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "RateWindow.ts"))]
pub struct RateWindow {
    /// A stable machine key: `"5h"` | `"weekly"` | `"weekly_opus"` |
    /// `"weekly_sonnet"` | `"model:<id>"`.
    pub kind: String,
    /// Display label (`"Session (5h)"`, `"Weekly"`, `"Opus weekly"`, …).
    pub label: String,
    /// Utilization normalized to `0..=100` (Claude sends `0..1`, Codex sends
    /// `0..100` — normalized once at parse, spec §3.5).
    pub used_percent: f64,
    /// ISO-8601 reset instant — the countdown source. `None` when the provider
    /// omits it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub resets_at: Option<String>,
    /// The window length in seconds (`limit_window_seconds`) when the provider
    /// gives it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub window_seconds: Option<u64>,
    /// Display name for a model-scoped window (Opus / Sonnet / a promotional
    /// model), when the window is model-scoped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub scope_model: Option<String>,
}

/// Popover-only extra-credit info: Codex `credits` / Claude `extra_usage`. Every
/// field optional — the two providers populate different subsets.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "Credits.ts"))]
pub struct Credits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub has_credits: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub unlimited: Option<bool>,
    /// A balance in MAJOR currency units. (Claude `extra_usage` amounts are MINOR
    /// units on the wire — the parser divides by 100 before it lands here.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub balance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub currency: Option<String>,
}

/// The degraded-state machine. EVERY non-`ok` state has a defined, non-crashing UI
/// affordance (spec §3.6) — this enum is the single source of "what the widget
/// shows". Serializes to a camelCase TS string union (like `DiffStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "UsageStatus.ts"))]
pub enum UsageStatus {
    /// Fresh windows fetched.
    Ok,
    /// Transient failure; showing last-good (spec decision 4).
    Stale,
    /// 401 / expired token → "run `claude`/`codex` to re-sign-in". NEVER refreshed
    /// (spec decision 4).
    Unauthorized,
    /// 429; in a `Retry-After` cooldown, showing last-good.
    RateLimited,
    /// No credentials on disk → dormant row (spec decision 3).
    NotConnected,
    /// A 4xx/5xx we don't model, or a shape we can't parse → dim, keep last-good.
    Unsupported,
    /// The meter is opt-in-off (spec decision 5) — the whole widget is in its
    /// "Enable" state.
    Disabled,
}

/// The popover-only local cost estimate (spec §3.8) — its OWN type, computed on
/// demand by `get_usage_cost`, NEVER on the 10-min poll. ALWAYS labeled approximate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "UsageCost.ts"))]
pub struct UsageCost {
    pub provider: String,
    /// The summed USD estimate from local session logs, or `None` when the provider
    /// has no transcripts to sum (never a misleading `$0`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub cost_usd: Option<f64>,
    /// Summed token usage (reuses the Trust Report `TokenTotals`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub tokens: Option<TokenTotals>,
    /// ALWAYS `true` — the render labels it "≈ approximate, from local session logs".
    pub approximate: bool,
    /// ISO-8601 of when this scan ran.
    pub computed_at: String,
}
