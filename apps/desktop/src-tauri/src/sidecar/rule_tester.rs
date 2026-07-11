//! The one-shot RuleTester validation command: `validate_plugin_rule` (issue #185).
//!
//! Answers "is this armed lint-plugin check a REAL rule that actually fires, not a
//! placebo?" by loading the rule and running it through ESLint's `RuleTester` on
//! demand. The Harness arm gate (`arm_harness_gauntlet_check`) already proves a check
//! is *wired* into the target repo's ESLint config; this is the additive confidence
//! that the wired rule is a well-formed rule that actually reports.
//!
//! ## Why here (next to `list_models` / `get_capabilities`)
//!
//! The validation itself is ENGINE-side and MUST be: a Rust-spawned bare `node` can't
//! load the TS/ESM/CJS rules Nightcore ships, and `RuleTester`'s constructor API
//! varies across ESLint versions — the Bun sidecar owns cross-toolchain rule loading
//! and runs the rule against the TARGET project's own ESLint. So this is a
//! request/reply [`SurfaceQuery`] through the sidecar [`query`] transport — the same
//! shape as [`super::get_capabilities`] / [`super::list_models`], hence it lives in
//! `sidecar/` rather than `commands/`.
//!
//! ## Fail-soft
//!
//! The engine runner never throws: a rule that won't resolve, an ESLint that won't
//! load, or a malformed rule is reported as a [`RuleValidationResult`] with
//! `outcome: "error"` (and `ruleLoaded: false`), so the reply is `ok: true` and the UI
//! renders a clear diagnostic instead of a crash. A `false` `ok` here therefore only
//! signals an unexpected transport/engine failure.

use serde_json::Value;
use tauri::AppHandle;

use crate::contracts::{RuleValidationResult, SurfaceQuery};

use super::query;

/// Validate an armed lint-plugin rule via ESLint's `RuleTester`, over the
/// `validate-rule` seam (engine → cross-toolchain rule load + RuleTester run). Routes
/// through the sidecar [`query`] transport (which lazily spawns the child + its
/// reader), so it also starts the sidecar on first use.
///
/// `rule_path` is a single-rule module OR a plugin exposing a `rules` map; `rule_name`
/// selects the rule within a plugin (omit ⇒ derived from `rule_id`'s last segment).
/// `project_path` roots a relative `rule_path` and the ESLint toolchain resolution.
/// `valid_cases` / `invalid_cases` are RuleTester cases (source, or a JSON case
/// object); omit both for a structural probe.
#[tauri::command]
pub async fn validate_plugin_rule(
    app: AppHandle,
    rule_id: String,
    rule_path: String,
    rule_name: Option<String>,
    project_path: Option<String>,
    valid_cases: Option<Vec<String>>,
    invalid_cases: Option<Vec<String>>,
) -> Result<RuleValidationResult, String> {
    let reply = query(
        &app,
        SurfaceQuery::ValidateRule {
            // `requestId` is overwritten by `query` with a fresh uuid.
            request_id: String::new(),
            rule_id,
            rule_path,
            rule_name,
            project_path,
            valid_cases: valid_cases.unwrap_or_default(),
            invalid_cases: invalid_cases.unwrap_or_default(),
        },
    )
    .await?;
    if reply.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(reply
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("validate-rule query failed")
            .to_string());
    }
    let result = reply
        .get("ruleValidation")
        .ok_or("validate-rule reply missing its result")?;
    serde_json::from_value(result.clone())
        .map_err(|e| format!("malformed rule-validation result from the engine: {e}"))
}
