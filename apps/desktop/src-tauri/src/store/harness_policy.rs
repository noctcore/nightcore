//! The harness runtime policy (hardening module #3) — the `policy` key of
//! `<project>/.nightcore/harness.json`, resolved at session dispatch and carried
//! on `start-session` so the ENGINE's PreToolUse gate enforces it for the whole
//! run (the gate that holds even under `bypassPermissions`).
//!
//! Like [`crate::store::context`] this is a pure read seam over a Nightcore-owned
//! project file — no in-memory registry. The manifest is written by the
//! allowlisted Rust writer ([`crate::sidecar::harness`]'s `write_merge_manifest`,
//! which preserves the `policy` key verbatim) or hand-authored; it is NEVER model
//! output, so the patterns resolved here are trusted project config.
//!
//! ## Resolution semantics (mirrors the gauntlet's lenient posture)
//! - Manifest ABSENT ⇒ `None` — no policy layer at all (the pre-feature shape;
//!   projects without a manifest are completely unaffected).
//! - Present but UNREADABLE (EACCES/EIO, not `NotFound`) ⇒ warn + `None` — a
//!   security layer going dark deserves a log line, unlike a plain absent file.
//! - Malformed JSON / non-object root ⇒ warn + `None` — the gauntlet already
//!   warn-and-skips such a file, and there is no parseable intent to honor.
//! - `policy.enabled == false` ⇒ `None` — the documented wholesale opt-out. A
//!   present-but-non-bool `enabled` (`"false"`, `0`) is NOT the opt-out: it warns
//!   and the layer still arms (fail toward protection, but visibly).
//! - `policy` key ABSENT (or not an object) ⇒ `Some(empty policy)`: the layer
//!   still arms so the engine's IMPLICIT `.nightcore/**` self-protection guards
//!   the manifest — a project that armed gauntlet checks must not have an agent
//!   quietly edit the config that gates it.
//! - Array entries are salvaged per-entry: non-string entries are warn-and-skipped
//!   (a single typo never sinks the whole policy).

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::contracts::HarnessPolicy;

/// The per-project structure-lock manifest: `<path>/.nightcore/harness.json`.
/// Kept in lockstep with the gauntlet's `CONFIG_REL_PATH` and the apply writer's
/// `MANIFEST_REL_PATH` (one file, three deliberately separate readers/writer).
fn manifest_file(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".nightcore/harness.json")
}

/// The string entries of `value[key]`, warn-and-skipping non-string entries.
/// Absent / non-array ⇒ empty (a policy section may declare only one list).
fn string_entries(policy: &Value, key: &str) -> Vec<String> {
    let Some(items) = policy.get(key).and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| match item.as_str() {
            Some(s) => Some(s.to_string()),
            None => {
                tracing::warn!(
                    target: "nightcore::harness_policy",
                    key,
                    "skipping non-string policy entry"
                );
                None
            }
        })
        .collect()
}

/// Resolve the effective harness runtime policy for a project, or `None` when no
/// policy layer should be armed (no manifest, malformed manifest, or
/// `policy.enabled: false`). See the module header for the full semantics.
pub fn read_policy(project_path: &str) -> Option<HarnessPolicy> {
    let raw = match std::fs::read_to_string(manifest_file(project_path)) {
        Ok(raw) => raw,
        // A plain absent file is the pre-feature shape (no manifest → no layer),
        // silent by design. Any OTHER IO error (EACCES/EIO on a present file) is a
        // security layer going dark, so it warns before failing open.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!(
                target: "nightcore::harness_policy",
                error = %e,
                "cannot read .nightcore/harness.json; not arming the policy layer"
            );
            return None;
        }
    };
    let root: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                target: "nightcore::harness_policy",
                error = %e,
                "malformed .nightcore/harness.json; not arming the policy layer"
            );
            return None;
        }
    };
    if !root.is_object() {
        tracing::warn!(
            target: "nightcore::harness_policy",
            "non-object .nightcore/harness.json; not arming the policy layer"
        );
        return None;
    }

    let policy = root.get("policy");
    if let Some(p) = policy {
        // The wholesale opt-out: `"policy": { "enabled": false, … }`.
        if p.get("enabled").and_then(Value::as_bool) == Some(false) {
            return None;
        }
        // A present-but-non-bool `enabled` is NOT the opt-out spelling — warn so a
        // `"enabled": "false"` / `0` typo doesn't silently keep the layer armed
        // while the author believes they disabled it.
        if let Some(enabled) = p.get("enabled") {
            if !enabled.is_boolean() {
                tracing::warn!(
                    target: "nightcore::harness_policy",
                    "`policy.enabled` in .nightcore/harness.json is not a boolean; the layer stays armed (use `false` to opt out)"
                );
            }
        }
        if !p.is_object() {
            tracing::warn!(
                target: "nightcore::harness_policy",
                "non-object `policy` in .nightcore/harness.json; arming with an empty policy"
            );
        }
    }

    // A manifest with no (usable) `policy` section still arms an EMPTY policy:
    // the engine's implicit self-protection then guards the manifest itself.
    let policy = policy.cloned().unwrap_or(Value::Null);
    Some(HarnessPolicy {
        protected_paths: string_entries(&policy, "protectedPaths"),
        deny_bash_patterns: string_entries(&policy, "denyBashPatterns"),
        deny_read_paths: string_entries(&policy, "denyReadPaths"),
        disallowed_tools: string_entries(&policy, "disallowedTools"),
        allow_tools: string_entries(&policy, "allowTools"),
        ask_tools: string_entries(&policy, "askTools"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Write `<tmp>/.nightcore/harness.json` with `content` and return the root.
    fn write_manifest(tmp: &TempDir, content: &str) -> String {
        let dir = tmp.path().join(".nightcore");
        std::fs::create_dir_all(&dir).expect("create .nightcore");
        std::fs::write(dir.join("harness.json"), content).expect("write manifest");
        tmp.path().to_string_lossy().to_string()
    }

    #[test]
    fn absent_manifest_arms_nothing() {
        let tmp = TempDir::new().expect("temp dir");
        assert!(read_policy(&tmp.path().to_string_lossy()).is_none());
    }

    #[test]
    fn malformed_manifest_arms_nothing() {
        let tmp = TempDir::new().expect("temp dir");
        let root = write_manifest(&tmp, "{ not json");
        assert!(read_policy(&root).is_none());
    }

    #[test]
    fn manifest_without_policy_arms_an_empty_policy() {
        let tmp = TempDir::new().expect("temp dir");
        let root = write_manifest(&tmp, r#"{ "checks": [] }"#);
        let policy = read_policy(&root).expect("empty policy armed");
        assert!(policy.protected_paths.is_empty());
        assert!(policy.deny_bash_patterns.is_empty());
    }

    #[test]
    fn disabled_policy_arms_nothing() {
        let tmp = TempDir::new().expect("temp dir");
        let root = write_manifest(
            &tmp,
            r#"{ "policy": { "enabled": false, "protectedPaths": ["bun.lock"] } }"#,
        );
        assert!(read_policy(&root).is_none());
    }

    #[test]
    fn full_policy_resolves_both_lists() {
        let tmp = TempDir::new().expect("temp dir");
        let root = write_manifest(
            &tmp,
            r#"{
              "checks": [{ "name": "lint", "kind": "lint-plugin", "command": "npx eslint ." }],
              "policy": {
                "protectedPaths": ["bun.lock", "migrations/**"],
                "denyBashPatterns": ["--no-verify"]
              }
            }"#,
        );
        let policy = read_policy(&root).expect("policy armed");
        assert_eq!(policy.protected_paths, vec!["bun.lock", "migrations/**"]);
        assert_eq!(policy.deny_bash_patterns, vec!["--no-verify"]);
        assert!(policy.deny_read_paths.is_empty());
        assert!(policy.disallowed_tools.is_empty());
        assert!(policy.allow_tools.is_empty());
        assert!(policy.ask_tools.is_empty());
    }

    #[test]
    fn allow_and_ask_tool_lists_resolve() {
        let tmp = TempDir::new().expect("temp dir");
        let root = write_manifest(
            &tmp,
            r#"{
              "policy": {
                "allowTools": ["WebSearch", "Bash(git status:*)"],
                "askTools": ["Write", "mcp__acme__push"]
              }
            }"#,
        );
        let policy = read_policy(&root).expect("policy armed");
        assert_eq!(policy.allow_tools, vec!["WebSearch", "Bash(git status:*)"]);
        assert_eq!(policy.ask_tools, vec!["Write", "mcp__acme__push"]);
        assert!(policy.disallowed_tools.is_empty());
    }

    #[test]
    fn read_deny_and_tool_lists_resolve() {
        let tmp = TempDir::new().expect("temp dir");
        let root = write_manifest(
            &tmp,
            r#"{
              "policy": {
                "denyReadPaths": [".env*", "secrets/**"],
                "disallowedTools": ["WebSearch"]
              }
            }"#,
        );
        let policy = read_policy(&root).expect("policy armed");
        assert_eq!(policy.deny_read_paths, vec![".env*", "secrets/**"]);
        assert_eq!(policy.disallowed_tools, vec!["WebSearch"]);
    }

    #[test]
    fn non_string_entries_are_skipped_not_fatal() {
        let tmp = TempDir::new().expect("temp dir");
        let root = write_manifest(
            &tmp,
            r#"{ "policy": { "protectedPaths": ["bun.lock", 7, null, "Cargo.lock"] } }"#,
        );
        let policy = read_policy(&root).expect("policy armed");
        assert_eq!(policy.protected_paths, vec!["bun.lock", "Cargo.lock"]);
    }

    #[test]
    fn non_bool_enabled_still_arms_the_layer() {
        // `"enabled": "false"` (string) is NOT the boolean opt-out spelling — the
        // layer stays armed (fail toward protection) rather than silently disabling.
        let tmp = TempDir::new().expect("temp dir");
        let root = write_manifest(
            &tmp,
            r#"{ "policy": { "enabled": "false", "protectedPaths": ["bun.lock"] } }"#,
        );
        let policy = read_policy(&root).expect("layer stays armed for a non-bool enabled");
        assert_eq!(policy.protected_paths, vec!["bun.lock"]);
    }

    #[test]
    fn non_object_policy_arms_an_empty_policy() {
        let tmp = TempDir::new().expect("temp dir");
        let root = write_manifest(&tmp, r#"{ "policy": "on" }"#);
        let policy = read_policy(&root).expect("empty policy armed");
        assert!(policy.protected_paths.is_empty());
        assert!(policy.deny_bash_patterns.is_empty());
    }
}
