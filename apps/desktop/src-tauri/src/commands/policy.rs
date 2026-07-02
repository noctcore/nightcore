//! The harness policy authoring commands (the hardening catalog's policy UI seam).
//!
//! `.nightcore/harness.json`'s `policy` block is Rust-read/-written ONLY — never
//! model output. Until now it was hand-authored; these commands give the web a
//! typed read (`get_harness_policy_file`) and a merge-by-key write
//! (`update_harness_policy_file`) over the ACTIVE project's manifest. The path is
//! always resolved server-side from the active project — never caller-supplied —
//! so the webview cannot point the writer at an arbitrary file.
//!
//! ## Writer posture (why merge-by-key over serialize-a-struct)
//! The manifest is shared state: `checks` belongs to the gauntlet, `policy` may
//! carry fields newer than this build knows (workers add policy keys in
//! parallel). The writer therefore edits the file as raw [`serde_json::Value`],
//! overwriting ONLY the keys present in the patch — every unknown key in the
//! root, the `policy` object, and `policy.diffBudget` survives a round-trip
//! verbatim. A malformed manifest is a hard ERROR (there is no parseable intent
//! to merge into; silently replacing it would destroy the user's config), unlike
//! the lenient read side which mirrors [`crate::store::harness_policy`]'s
//! fail-open posture.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::AppHandle;
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

/// The per-project structure-lock manifest: `<path>/.nightcore/harness.json`.
/// Kept in lockstep with `store/harness_policy.rs::manifest_file` (one file,
/// deliberately separate readers/writer seams).
fn manifest_file(project_path: &str) -> std::path::PathBuf {
    std::path::Path::new(project_path).join(".nightcore/harness.json")
}

/// The `policy.diffBudget` shape as authored in the manifest (both limits
/// optional, mirroring `workflow/diff_budget.rs`: a budget with neither limit is
/// unconfigured, not zero).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PolicyDiffBudget.ts"))]
pub struct PolicyDiffBudget {
    pub max_changed_lines: Option<u64>,
    pub max_changed_files: Option<u64>,
}

/// The full policy block of the active project's manifest, as the UI edits it.
/// Field semantics mirror the runtime readers: `enabled` defaults to `true` when
/// absent (the layer arms unless explicitly opted out), lists default empty, and
/// `diff_budget` is `None` when the manifest declares no `diffBudget` object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "HarnessPolicyFile.ts"))]
pub struct HarnessPolicyFile {
    pub enabled: bool,
    pub protected_paths: Vec<String>,
    pub deny_bash_patterns: Vec<String>,
    pub deny_read_paths: Vec<String>,
    pub disallowed_tools: Vec<String>,
    pub allow_tools: Vec<String>,
    pub ask_tools: Vec<String>,
    pub diff_budget: Option<PolicyDiffBudget>,
    /// Whether `.nightcore/harness.json` exists at all — the UI tells "editing an
    /// existing manifest" apart from "saving will create one".
    pub manifest_exists: bool,
}

impl HarnessPolicyFile {
    /// The pre-manifest defaults: armed-when-present semantics (`enabled: true`),
    /// empty lists, no diff budget.
    fn defaults(manifest_exists: bool) -> Self {
        Self {
            enabled: true,
            protected_paths: Vec::new(),
            deny_bash_patterns: Vec::new(),
            deny_read_paths: Vec::new(),
            disallowed_tools: Vec::new(),
            allow_tools: Vec::new(),
            ask_tools: Vec::new(),
            diff_budget: None,
            manifest_exists,
        }
    }
}

/// A partial policy update. `None` fields are left untouched in the file
/// (merge-by-key); present fields replace exactly that key. `diff_budget` is
/// all-or-nothing over the two KNOWN limits: `Some(budget)` sets/unsets each
/// limit to the given value (a `None` limit removes that key), and unknown keys
/// inside `diffBudget` still survive. The `diffBudget` key itself is dropped when
/// it ends up empty.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "HarnessPolicyPatch.ts"))]
pub struct HarnessPolicyPatch {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub protected_paths: Option<Vec<String>>,
    #[serde(default)]
    pub deny_bash_patterns: Option<Vec<String>>,
    #[serde(default)]
    pub deny_read_paths: Option<Vec<String>>,
    #[serde(default)]
    pub disallowed_tools: Option<Vec<String>>,
    #[serde(default)]
    pub allow_tools: Option<Vec<String>>,
    #[serde(default)]
    pub ask_tools: Option<Vec<String>>,
    #[serde(default)]
    pub diff_budget: Option<PolicyDiffBudget>,
}

/// The string entries of `policy[key]`, skipping non-string entries (same
/// per-entry salvage as the runtime reader — a single typo never hides the rest).
fn string_entries(policy: &Value, key: &str) -> Vec<String> {
    policy
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Read the active-project policy block for the UI. Lenient like the runtime
/// reader: an absent manifest (or absent/malformed `policy` key) yields the
/// defaults — the editor then starts from a blank slate and `manifest_exists`
/// tells the UI whether saving creates or edits the file.
pub fn read_policy_file(project_path: &str) -> HarnessPolicyFile {
    let path = manifest_file(project_path);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return HarnessPolicyFile::defaults(false);
        }
        // Present but unreadable: the editor still opens (defaults), but knows a
        // manifest is there so it doesn't claim "saving will create one".
        Err(e) => {
            tracing::warn!(
                target: "nightcore::policy_commands",
                error = %e,
                "cannot read .nightcore/harness.json; showing policy defaults"
            );
            return HarnessPolicyFile::defaults(true);
        }
    };
    let root: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                target: "nightcore::policy_commands",
                error = %e,
                "malformed .nightcore/harness.json; showing policy defaults"
            );
            return HarnessPolicyFile::defaults(true);
        }
    };
    let policy = root.get("policy").cloned().unwrap_or(Value::Null);

    let diff_budget = policy
        .get("diffBudget")
        .and_then(Value::as_object)
        .map(|b| PolicyDiffBudget {
            max_changed_lines: b.get("maxChangedLines").and_then(Value::as_u64),
            max_changed_files: b.get("maxChangedFiles").and_then(Value::as_u64),
        });

    HarnessPolicyFile {
        // Absent / non-bool `enabled` means the layer arms (the runtime reader's
        // fail-toward-protection posture) — only an explicit `false` reads as off.
        enabled: policy.get("enabled").and_then(Value::as_bool) != Some(false),
        protected_paths: string_entries(&policy, "protectedPaths"),
        deny_bash_patterns: string_entries(&policy, "denyBashPatterns"),
        deny_read_paths: string_entries(&policy, "denyReadPaths"),
        disallowed_tools: string_entries(&policy, "disallowedTools"),
        allow_tools: string_entries(&policy, "allowTools"),
        ask_tools: string_entries(&policy, "askTools"),
        diff_budget,
        manifest_exists: true,
    }
}

/// Merge `patch` into the manifest's `policy` block and persist atomically,
/// returning the re-read result. Only the keys PRESENT in the patch are written;
/// every unknown key (root, `policy`, `diffBudget`) survives verbatim. Creates
/// `.nightcore/harness.json` when absent; ERRORS on a malformed manifest rather
/// than silently replacing user config.
pub fn write_policy_patch(
    project_path: &str,
    patch: &HarnessPolicyPatch,
) -> Result<HarnessPolicyFile, String> {
    let path = manifest_file(project_path);

    // Load the raw manifest (or a fresh object). Unlike the lenient readers, a
    // present-but-unparseable file must FAIL the write: merging requires a
    // parseable base, and clobbering it would eat the gauntlet's `checks` etc.
    let mut root: Value = match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| {
            format!(
                "{} is not valid JSON ({e}); fix it by hand before editing the policy",
                path.display()
            )
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let Some(root_map) = root.as_object_mut() else {
        return Err(format!(
            "{} has a non-object root; fix it by hand before editing the policy",
            path.display()
        ));
    };

    // `policy`: reuse the existing object so its unknown keys survive. A present
    // non-object `policy` carries no keys worth preserving — replace it.
    let policy_slot = root_map
        .entry("policy".to_string())
        .or_insert_with(|| json!({}));
    if !policy_slot.is_object() {
        *policy_slot = json!({});
    }
    let policy = policy_slot
        .as_object_mut()
        .expect("policy was just ensured to be an object");

    if let Some(enabled) = patch.enabled {
        policy.insert("enabled".to_string(), json!(enabled));
    }
    for (key, list) in [
        ("protectedPaths", &patch.protected_paths),
        ("denyBashPatterns", &patch.deny_bash_patterns),
        ("denyReadPaths", &patch.deny_read_paths),
        ("disallowedTools", &patch.disallowed_tools),
        ("allowTools", &patch.allow_tools),
        ("askTools", &patch.ask_tools),
    ] {
        if let Some(list) = list {
            policy.insert(key.to_string(), json!(list));
        }
    }
    if let Some(budget) = &patch.diff_budget {
        // Merge INSIDE diffBudget by key too: only the two known limits are
        // set/removed; any unknown sibling keys survive. An emptied object drops
        // the key entirely (the runtime treats a limitless budget as unconfigured).
        let mut b: Map<String, Value> = match policy.get("diffBudget") {
            Some(Value::Object(existing)) => existing.clone(),
            _ => Map::new(),
        };
        match budget.max_changed_lines {
            Some(v) => {
                b.insert("maxChangedLines".to_string(), json!(v));
            }
            None => {
                b.remove("maxChangedLines");
            }
        }
        match budget.max_changed_files {
            Some(v) => {
                b.insert("maxChangedFiles".to_string(), json!(v));
            }
            None => {
                b.remove("maxChangedFiles");
            }
        }
        if b.is_empty() {
            policy.remove("diffBudget");
        } else {
            policy.insert("diffBudget".to_string(), Value::Object(b));
        }
    }

    let json = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("failed to serialize harness manifest: {e}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    // Atomic temp+rename: a crash or concurrent reader (the gauntlet, the policy
    // resolver at dispatch) sees the old manifest or the new one, never a torn write.
    crate::store::write_atomic(&path, json.as_bytes())
        .map_err(|e| format!("failed to write {}: {e}", path.display()))?;

    Ok(read_policy_file(project_path))
}

// --- Commands ---------------------------------------------------------------

/// The active project's path via `try_state` (blocking-pool safe: an unmanaged
/// store fails gracefully instead of panicking off the main thread).
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

/// Read the ACTIVE project's harness policy block for the editor UI. Async +
/// `spawn_blocking`: file IO must not stall the WKWebView (same posture as
/// `scan_injection_surface`).
#[tauri::command]
pub async fn get_harness_policy_file(app: AppHandle) -> Result<HarnessPolicyFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = active_project_path(&app)?;
        Ok(read_policy_file(&path))
    })
    .await
    .map_err(|e| format!("policy read failed to run: {e}"))?
}

/// Merge a policy patch into the ACTIVE project's `.nightcore/harness.json`
/// (creating it when absent) and return the updated policy. The target path is
/// resolved server-side — never caller-supplied.
#[tauri::command]
pub async fn update_harness_policy_file(
    app: AppHandle,
    patch: HarnessPolicyPatch,
) -> Result<HarnessPolicyFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = active_project_path(&app)?;
        write_policy_patch(&path, &patch)
    })
    .await
    .map_err(|e| format!("policy write failed to run: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn root_of(tmp: &TempDir) -> String {
        tmp.path().to_string_lossy().to_string()
    }

    fn write_manifest(tmp: &TempDir, content: &str) {
        let dir = tmp.path().join(".nightcore");
        std::fs::create_dir_all(&dir).expect("create .nightcore");
        std::fs::write(dir.join("harness.json"), content).expect("write manifest");
    }

    fn read_manifest_value(tmp: &TempDir) -> Value {
        let raw = std::fs::read_to_string(tmp.path().join(".nightcore/harness.json"))
            .expect("manifest exists");
        serde_json::from_str(&raw).expect("manifest parses")
    }

    // --- reader -------------------------------------------------------------

    #[test]
    fn absent_manifest_reads_as_defaults_without_a_manifest() {
        let tmp = TempDir::new().expect("temp dir");
        let file = read_policy_file(&root_of(&tmp));
        assert!(!file.manifest_exists);
        assert!(file.enabled, "the layer arms by default");
        assert!(file.protected_paths.is_empty());
        assert!(file.diff_budget.is_none());
    }

    #[test]
    fn manifest_without_policy_key_reads_as_defaults_with_a_manifest() {
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(&tmp, r#"{ "checks": [] }"#);
        let file = read_policy_file(&root_of(&tmp));
        assert!(file.manifest_exists);
        assert!(file.enabled);
        assert!(file.deny_read_paths.is_empty());
        assert!(file.diff_budget.is_none());
    }

    #[test]
    fn full_policy_reads_every_field_including_diff_budget() {
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(
            &tmp,
            r#"{
              "policy": {
                "enabled": false,
                "protectedPaths": ["bun.lock"],
                "denyBashPatterns": ["--no-verify"],
                "denyReadPaths": [".env*"],
                "disallowedTools": ["WebSearch"],
                "diffBudget": { "maxChangedLines": 400, "maxChangedFiles": 20 }
              }
            }"#,
        );
        let file = read_policy_file(&root_of(&tmp));
        assert!(!file.enabled);
        assert_eq!(file.protected_paths, vec!["bun.lock"]);
        assert_eq!(file.deny_bash_patterns, vec!["--no-verify"]);
        assert_eq!(file.deny_read_paths, vec![".env*"]);
        assert_eq!(file.disallowed_tools, vec!["WebSearch"]);
        assert_eq!(
            file.diff_budget,
            Some(PolicyDiffBudget {
                max_changed_lines: Some(400),
                max_changed_files: Some(20),
            })
        );
    }

    #[test]
    fn malformed_manifest_reads_as_defaults_but_flags_existence() {
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(&tmp, "{ not json");
        let file = read_policy_file(&root_of(&tmp));
        assert!(file.manifest_exists, "a malformed file still EXISTS");
        assert!(file.enabled);
    }

    // --- writer -------------------------------------------------------------

    #[test]
    fn absent_manifest_is_created_by_the_writer() {
        let tmp = TempDir::new().expect("temp dir");
        let patch = HarnessPolicyPatch {
            enabled: Some(true),
            protected_paths: Some(vec!["bun.lock".to_string()]),
            ..Default::default()
        };
        let file = write_policy_patch(&root_of(&tmp), &patch).expect("create manifest");
        assert!(file.manifest_exists);
        assert_eq!(file.protected_paths, vec!["bun.lock"]);
        // On disk too, at the fixed path.
        let value = read_manifest_value(&tmp);
        assert_eq!(value["policy"]["protectedPaths"][0], "bun.lock");
    }

    #[test]
    fn unknown_keys_survive_a_round_trip_at_every_level() {
        // A parallel worker's policy field (`futureKnob`), a root sibling
        // (`checks`), and an unknown diffBudget sibling must all survive a write
        // that touches other keys.
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(
            &tmp,
            r#"{
              "checks": [{ "name": "lint", "kind": "lint-plugin", "command": "npx eslint ." }],
              "rootExtra": { "nested": true },
              "policy": {
                "enabled": true,
                "futureKnob": ["keep-me"],
                "denyReadPaths": [".env*"],
                "diffBudget": { "maxChangedLines": 100, "futureLimit": 7 }
              }
            }"#,
        );
        let patch = HarnessPolicyPatch {
            deny_read_paths: Some(vec![".env*".to_string(), "secrets/**".to_string()]),
            diff_budget: Some(PolicyDiffBudget {
                max_changed_lines: Some(400),
                max_changed_files: None,
            }),
            ..Default::default()
        };
        write_policy_patch(&root_of(&tmp), &patch).expect("merge write");

        let value = read_manifest_value(&tmp);
        // Root siblings untouched.
        assert_eq!(value["checks"][0]["name"], "lint");
        assert_eq!(value["rootExtra"]["nested"], true);
        // Unknown policy key untouched.
        assert_eq!(value["policy"]["futureKnob"][0], "keep-me");
        // Patched key replaced.
        assert_eq!(value["policy"]["denyReadPaths"][1], "secrets/**");
        // Un-patched known key untouched.
        assert_eq!(value["policy"]["enabled"], true);
        // diffBudget merged by key: lines updated, unknown sibling kept, files
        // absent (the patch unset it and it wasn't there).
        assert_eq!(value["policy"]["diffBudget"]["maxChangedLines"], 400);
        assert_eq!(value["policy"]["diffBudget"]["futureLimit"], 7);
        assert!(value["policy"]["diffBudget"]
            .get("maxChangedFiles")
            .is_none());
    }

    #[test]
    fn clearing_both_limits_drops_the_diff_budget_key() {
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(
            &tmp,
            r#"{ "policy": { "diffBudget": { "maxChangedLines": 400, "maxChangedFiles": 20 } } }"#,
        );
        let patch = HarnessPolicyPatch {
            diff_budget: Some(PolicyDiffBudget::default()),
            ..Default::default()
        };
        let file = write_policy_patch(&root_of(&tmp), &patch).expect("clear budget");
        assert!(file.diff_budget.is_none());
        let value = read_manifest_value(&tmp);
        assert!(
            value["policy"].get("diffBudget").is_none(),
            "an emptied diffBudget is removed, not left as zero"
        );
    }

    #[test]
    fn absent_patch_fields_leave_the_file_untouched() {
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(
            &tmp,
            r#"{ "policy": { "protectedPaths": ["bun.lock"], "disallowedTools": ["WebSearch"] } }"#,
        );
        // An entirely-empty patch is a no-op merge.
        let file =
            write_policy_patch(&root_of(&tmp), &HarnessPolicyPatch::default()).expect("no-op");
        assert_eq!(file.protected_paths, vec!["bun.lock"]);
        assert_eq!(file.disallowed_tools, vec!["WebSearch"]);
    }

    #[test]
    fn malformed_manifest_refuses_the_write() {
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(&tmp, "{ not json");
        let err = write_policy_patch(&root_of(&tmp), &HarnessPolicyPatch::default())
            .expect_err("must not clobber an unparseable manifest");
        assert!(err.contains("not valid JSON"), "got: {err}");
        // The broken file is preserved byte-for-byte for the human to fix.
        let raw = std::fs::read_to_string(tmp.path().join(".nightcore/harness.json"))
            .expect("still present");
        assert_eq!(raw, "{ not json");
    }

    #[test]
    fn writer_leaves_no_temp_file_litter() {
        // The atomic write goes through a sibling temp file; after a successful
        // write exactly one file (the manifest) remains in `.nightcore/`.
        let tmp = TempDir::new().expect("temp dir");
        let patch = HarnessPolicyPatch {
            enabled: Some(false),
            ..Default::default()
        };
        write_policy_patch(&root_of(&tmp), &patch).expect("write");
        let entries: Vec<String> = std::fs::read_dir(tmp.path().join(".nightcore"))
            .expect("read .nightcore")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries, vec!["harness.json"]);
    }

    #[test]
    fn written_policy_is_honored_by_the_runtime_reader() {
        // The editor writes; the dispatch-time resolver reads: the two seams must
        // agree on the on-disk spelling.
        let tmp = TempDir::new().expect("temp dir");
        let patch = HarnessPolicyPatch {
            deny_read_paths: Some(vec!["secrets/**".to_string()]),
            deny_bash_patterns: Some(vec!["--no-verify".to_string()]),
            ..Default::default()
        };
        write_policy_patch(&root_of(&tmp), &patch).expect("write");
        let armed = crate::store::harness_policy::read_policy(&root_of(&tmp))
            .expect("runtime reader arms the layer");
        assert_eq!(armed.deny_read_paths, vec!["secrets/**"]);
        assert_eq!(armed.deny_bash_patterns, vec!["--no-verify"]);
    }
}
