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
//!
//! ## Trust boundary (issue #194 item 4)
//!
//! `RuleTester` LOADS AND RUNS the rule's `create()` — this is code execution. So the
//! command does NOT trust the webview with either the project root or the rule module:
//!
//!  1. `project_path` is server-resolved from the ACTIVE project (never caller-supplied),
//!     mirroring the Checks-manager / policy commands.
//!  2. `rule_path` is contained with the SAME `safe_join` symlink guard the harness
//!     file-write path uses — repo-relative, no `..`, no symlink escape, never an
//!     execution sink — so a compromised webview can never point RuleTester at a file
//!     outside the project (or a symlink to one).
//!  3. Armed-only: the request must name an ARMED `lint-plugin` check in the project's
//!     manifest (the T15 decision). Combined with (2), the only code RuleTester can
//!     execute is a rule module INSIDE the user's own repo, reached via a check a human
//!     already armed — never an arbitrary path the client chose.

use serde_json::Value;
use std::path::Path;
use tauri::AppHandle;

use crate::contracts::{RuleValidationResult, SurfaceQuery};
use crate::store::harness_manifest::ArmedCheckFile;

use super::query;

/// The active project's path via `try_state` (blocking-pool safe: an unmanaged store
/// fails gracefully instead of panicking off the main thread). Mirrors the identical
/// helper on the Checks-manager / policy commands — the manifest and toolchain root is
/// always the active project, never a value the webview supplies.
fn active_project_path(app: &AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let projects = app
        .try_state::<crate::project::ProjectStore>()
        .ok_or_else(|| "project store unavailable".to_string())?;
    projects
        .active()
        .map(|p| p.path)
        .ok_or_else(|| "no active project".to_string())
}

/// The server-resolved, containment-checked inputs a validation run is allowed to use.
struct AuthorizedRule {
    /// The active project's root (ESLint toolchain resolution root).
    project_path: String,
    /// The rule module as an ABSOLUTE path proven contained inside `project_path` (no
    /// `..`, no symlink escape, not an execution sink).
    rule_path: String,
}

/// Resolve the active project, then authorize the request against it. Splits the
/// AppHandle-bound resolution (`active_project_path`) from the testable core
/// ([`authorize_rule`]). Pure filesystem + store reads, so it runs on the blocking pool.
fn authorize_validation(
    app: &AppHandle,
    rule_id: &str,
    rule_path: &str,
) -> Result<AuthorizedRule, String> {
    let project_path = active_project_path(app)?;
    let armed = crate::store::harness_manifest::read_armed_checks(&project_path);
    let contained = authorize_rule(Path::new(&project_path), &armed, rule_id, rule_path)?;
    Ok(AuthorizedRule {
        project_path,
        rule_path: contained,
    })
}

/// Require `rule_id` to name an ARMED `lint-plugin` check in `armed`, then contain
/// `rule_path` inside `project_root`, returning the absolute contained path. Split from
/// [`authorize_validation`] so both gates are unit-testable without an `AppHandle`. A
/// rejection here is a security-relevant event (an unauthorized or out-of-tree validation
/// attempt), so it is logged, not just bubbled.
fn authorize_rule(
    project_root: &Path,
    armed: &[ArmedCheckFile],
    rule_id: &str,
    rule_path: &str,
) -> Result<String, String> {
    // Armed-only (T15): RuleTester executes the rule's `create()`, so validation is
    // restricted to a rule a human already armed. The Checks Manager sends the armed
    // check's NAME as `rule_id`; the arm/edit path does not persist a `configPath`, so the
    // check NAME (not its config path) is the reliable join key. Require an armed
    // `lint-plugin` entry with that name.
    let is_armed_lint_rule = armed
        .iter()
        .any(|c| c.kind == "lint-plugin" && c.name == rule_id);
    if !is_armed_lint_rule {
        tracing::warn!(target: "nightcore::rule_tester", rule_id = %rule_id, "refused to validate a rule with no matching armed lint-plugin check");
        return Err(format!(
            "`{rule_id}` is not an armed lint-plugin check in this project — validation \
             runs the rule's create() (code execution), so it is restricted to rules you \
             have already armed. Arm the lint-plugin check first, then validate."
        ));
    }

    // Contain the rule module inside the active project with the shared symlink guard the
    // harness file-write path uses. Rejects `..`/absolute/symlink-escaping paths (and, as a
    // bonus, execution sinks) — a compromised webview can never reach a file outside the repo.
    let contained = crate::infra::safe_join::safe_join(project_root, rule_path).map_err(|e| {
        tracing::warn!(target: "nightcore::rule_tester", rule_id = %rule_id, rule_path = %rule_path, error = %e, "rule path rejected (containment)");
        e
    })?;
    Ok(contained.to_string_lossy().into_owned())
}

/// Validate an armed lint-plugin rule via ESLint's `RuleTester`, over the
/// `validate-rule` seam (engine → cross-toolchain rule load + RuleTester run). Routes
/// through the sidecar [`query`] transport (which lazily spawns the child + its
/// reader), so it also starts the sidecar on first use.
///
/// `rule_id` names the ARMED `lint-plugin` check being validated (the Checks-manager
/// check name); `rule_path` is its rule/plugin module, repo-relative to the ACTIVE
/// project. `rule_name` selects the rule within a plugin (omit ⇒ derived from `rule_id`'s
/// last segment). `valid_cases` / `invalid_cases` are RuleTester cases (source, or a JSON
/// case object); omit both for a structural probe. The project root and the contained
/// rule path are resolved SERVER-SIDE (see the module trust-boundary docs) — the client
/// supplies neither.
#[tauri::command]
pub async fn validate_plugin_rule(
    app: AppHandle,
    rule_id: String,
    rule_path: String,
    rule_name: Option<String>,
    valid_cases: Option<Vec<String>>,
    invalid_cases: Option<Vec<String>>,
) -> Result<RuleValidationResult, String> {
    // Server-resolve the project, enforce armed-only, and contain the rule path off the
    // async runtime thread (store + canonicalize are blocking filesystem work).
    let authorized = {
        let app = app.clone();
        let rule_id = rule_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            authorize_validation(&app, &rule_id, &rule_path)
        })
        .await
        .map_err(|e| format!("validate-rule preflight failed to run: {e}"))??
    };
    let AuthorizedRule {
        project_path,
        rule_path,
    } = authorized;

    let reply = query(
        &app,
        SurfaceQuery::ValidateRule {
            // `requestId` is overwritten by `query` with a fresh uuid.
            request_id: String::new(),
            rule_id,
            rule_path,
            rule_name,
            project_path: Some(project_path),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal armed-check descriptor with the given name + kind.
    fn armed(name: &str, kind: &str) -> ArmedCheckFile {
        ArmedCheckFile {
            name: name.into(),
            kind: kind.into(),
            command: "npx eslint .".into(),
            enabled: true,
            timeout_ms: None,
            config_path: None,
            convention_fingerprint: None,
        }
    }

    #[test]
    fn a_rule_id_with_no_armed_lint_plugin_check_is_refused() {
        // Nothing armed ⇒ no rule may be validated (RuleTester runs code): the request
        // is refused with the armed-only diagnostic before any path/engine work.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let err = authorize_rule(
            tmp.path(),
            &[],
            "folder-per-component",
            "tools/rules/index.js",
        )
        .expect_err("an unarmed rule must be refused");
        assert!(err.contains("not an armed lint-plugin check"), "got: {err}");
    }

    #[test]
    fn a_non_lint_plugin_armed_check_does_not_authorize_validation() {
        // A check with the SAME name but a different kind (e.g. `secret-scan`) is not a
        // RuleTester-validatable rule — the armed-only gate is kind-specific.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let checks = vec![armed("sec", "secret-scan")];
        let err = authorize_rule(tmp.path(), &checks, "sec", "tools/rules/index.js")
            .expect_err("a non-lint-plugin armed check must not authorize validation");
        assert!(err.contains("not an armed lint-plugin check"), "got: {err}");
    }

    #[test]
    fn an_armed_lint_plugin_rule_with_a_repo_relative_path_is_contained() {
        // The happy path: an armed `lint-plugin` check by name + a repo-relative rule
        // module resolves to an ABSOLUTE path inside the project root.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let rules_dir = tmp.path().join("tools/eslint-rules");
        std::fs::create_dir_all(&rules_dir).expect("mkdir");
        std::fs::write(rules_dir.join("index.js"), "export default {};").expect("rule file");
        let checks = vec![armed("folder-per-component", "lint-plugin")];

        let contained = authorize_rule(
            tmp.path(),
            &checks,
            "folder-per-component",
            "tools/eslint-rules/index.js",
        )
        .expect("an armed, in-repo rule is authorized");
        // The returned path is absolute and inside the canonical project root.
        let root_canon = tmp.path().canonicalize().expect("canon root");
        assert!(
            Path::new(&contained).starts_with(&root_canon),
            "contained path {contained} must sit under {}",
            root_canon.display()
        );
        assert!(contained.ends_with("index.js"), "got: {contained}");
    }

    #[test]
    fn an_armed_rule_with_a_parent_escape_is_rejected() {
        // Even for an armed check, a `..`-escaping rule path is refused by the shared
        // containment guard — the client can never reach a file outside the project.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let checks = vec![armed("folder-per-component", "lint-plugin")];
        let err = authorize_rule(
            tmp.path(),
            &checks,
            "folder-per-component",
            "../evil/rule.js",
        )
        .expect_err("a parent-escaping rule path must be rejected");
        assert!(err.contains("escapes the project"), "got: {err}");
    }

    #[test]
    fn an_armed_rule_with_an_absolute_path_is_rejected() {
        // An absolute rule path is refused too (repo-relative only) — a webview cannot
        // point RuleTester at `/etc/...` or a home-dir file.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let checks = vec![armed("folder-per-component", "lint-plugin")];
        let err = authorize_rule(tmp.path(), &checks, "folder-per-component", "/etc/passwd")
            .expect_err("an absolute rule path must be rejected");
        assert!(err.contains("repo-relative"), "got: {err}");
    }
}
