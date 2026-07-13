//! The single seam over `<project>/.nightcore/harness.json` (audit #35).
//!
//! The per-project structure-lock manifest is shared state: `checks` belongs to
//! the gauntlet, `policy` to the runtime policy layer, and either may carry keys
//! newer than this build knows. It used to be read/written through FOUR separate
//! path resolvers held together by "kept in lockstep" comments; this module is
//! now the one place that (a) resolves the manifest path, (b) reads the `policy`
//! block leniently for the editor UI, and (c) merge-writes a policy patch. The
//! consumers keep their own posture over these primitives:
//!
//! - [`crate::commands::policy`] — the thin `#[tauri::command]` shells over the
//!   reader/writer here.
//! - [`crate::store::harness_policy`] — the dispatch-time runtime resolver
//!   (fail-open lenient read of the `policy` key).
//! - `crate::sidecar::harness::apply` — the security-critical `checks` merge
//!   writer; it consumes only [`MANIFEST_REL_PATH`] and keeps its own hardened
//!   (symlink/clobber-defended) write path.
//! - `crate::workflow::gauntlet_project` — the gauntlet's lenient `checks` reader.
//!
//! ## Writer posture (why merge-by-key over serialize-a-struct)
//! The writer edits the file as raw [`serde_json::Value`], overwriting ONLY the
//! keys present in the patch — every unknown key in the root, the `policy`
//! object, and `policy.diffBudget` survives a round-trip verbatim. A malformed
//! manifest is a hard ERROR (there is no parseable intent to merge into;
//! silently replacing it would destroy the user's config), unlike the lenient
//! read side which mirrors [`crate::store::harness_policy`]'s fail-open posture.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

/// The manifest's project-relative path — the ONE spelling every reader/writer
/// resolves through (the apply writer routes it through its own `safe_join`).
pub(crate) const MANIFEST_REL_PATH: &str = ".nightcore/harness.json";

/// The current portable-lock manifest schema version — the additive root stamp the
/// portable-lock exporter (`sidecar::harness::export`, #134 PR 3) writes so the
/// standalone `@noctcore/harness` runner can parse `.nightcore/harness.json`
/// forward-compatibly. It is a root-level FORMAT stamp, orthogonal to the check
/// vocabulary (`HarnessCheckKind`) — never a `checks[]` kind and never on the arm
/// allowlist. The runner treats an absent stamp as `1` (a manifest armed before this
/// feature is a valid v1 bundle) and fails only on an unknown MAJOR.
pub const HARNESS_SCHEMA_VERSION: u64 = 1;

/// The per-project structure-lock manifest: `<project_path>/.nightcore/harness.json`.
pub(crate) fn manifest_file(project_path: &std::path::Path) -> std::path::PathBuf {
    project_path.join(MANIFEST_REL_PATH)
}

/// Load the manifest at `path` as a JSON object for a merge-write: an absent file
/// yields a fresh `{}`; a present-but-unparseable OR non-object manifest is a HARD
/// error (never clobber the user's config — every merge writer needs a parseable base).
/// `action` names the edit in the error ("editing the policy" / "editing checks" /
/// "exporting the portable lock"). The returned [`Value`] is always an object, so callers
/// may `.as_object_mut().expect(...)` it. This is the single load posture the policy,
/// checks, and schemaVersion writers share (extracted so a fix lands in one place).
fn load_manifest_for_merge(path: &std::path::Path, action: &str) -> Result<Value, String> {
    let root: Value = match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| {
            format!(
                "{} is not valid JSON ({e}); fix it by hand before {action}",
                path.display()
            )
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    if !root.is_object() {
        return Err(format!(
            "{} has a non-object root; fix it by hand before {action}",
            path.display()
        ));
    }
    Ok(root)
}

/// Persist a merge-written manifest to `path` atomically (temp + rename), creating the
/// `.nightcore/` parent if absent. The shared write tail every merge writer uses — a
/// concurrent gauntlet/policy reader sees the old file or the new one, never a torn write.
fn persist_manifest(path: &std::path::Path, json: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    crate::store::write_atomic(path, json.as_bytes())
        .map_err(|e| format!("failed to write {}: {e}", path.display()))
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
    /// The exec-sink downgrade list (`policy.allowExecSinks`), read-only here: the
    /// policy editor has no controls for it (only reachable by hand-editing the
    /// manifest — see `store::harness_policy::read_policy`). Exposed on this shape
    /// purely so the web's "is this policy armed" signal
    /// (`harnessPolicyHasRules` in `apps/web/src/lib/harness-governance.ts`) can see
    /// it and match the engine's identically-named check field-for-field (#308).
    pub allow_exec_sinks: Vec<String>,
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
            allow_exec_sinks: Vec::new(),
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
    let path = manifest_file(std::path::Path::new(project_path));
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
        allow_exec_sinks: string_entries(&policy, "allowExecSinks"),
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
    let path = manifest_file(std::path::Path::new(project_path));

    // Load the raw manifest (or a fresh object). Unlike the lenient readers, a
    // present-but-unparseable/non-object file must FAIL the write: merging requires a
    // parseable base, and clobbering it would eat the gauntlet's `checks` etc.
    let mut root = load_manifest_for_merge(&path, "editing the policy")?;
    let root_map = root
        .as_object_mut()
        .expect("load_manifest_for_merge guarantees a JSON object");

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
    persist_manifest(&path, &json)?;

    Ok(read_policy_file(project_path))
}

/// Stamp the additive `schemaVersion` root key onto the live manifest and return the
/// stamped manifest text (the portable-lock exporter writes the SAME bytes into the
/// bundle's `harness.json` copy — §3.3/§3.4). Merge-by-key over the raw [`Value`]: the
/// `checks` array, the `policy` block, and every unknown root key survive verbatim;
/// only `schemaVersion` is inserted. Creates `.nightcore/harness.json` as
/// `{ "schemaVersion": N }` when absent, and ERRORS on a malformed manifest (never
/// clobber the user's config) — the same posture as [`write_policy_patch`]. Idempotent:
/// a manifest already stamped at the current version is left byte-for-byte unchanged on
/// disk, so a re-export never rewrites the live file (the write is gated on the parsed
/// version, not the serialized string, which may differ in formatting).
pub fn stamp_live_manifest(project_path: &str) -> Result<String, String> {
    let path = manifest_file(std::path::Path::new(project_path));

    // A present-but-unparseable/non-object manifest must FAIL the stamp (shared merge
    // posture): merging requires a parseable base, never clobber the user's `checks`.
    let mut root = load_manifest_for_merge(&path, "exporting the portable lock")?;
    let root_map = root
        .as_object_mut()
        .expect("load_manifest_for_merge guarantees a JSON object");

    let already_stamped =
        root_map.get("schemaVersion").and_then(Value::as_u64) == Some(HARNESS_SCHEMA_VERSION);
    root_map.insert("schemaVersion".to_string(), json!(HARNESS_SCHEMA_VERSION));

    let json = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("failed to serialize harness manifest: {e}"))?;

    // Idempotent: only touch the live file when the stamp actually changes something.
    if !already_stamped {
        persist_manifest(&path, &json)?;
    }
    Ok(json)
}

// --- Armed checks (the `checks` block) --------------------------------------
//
// The Checks Manager (T7) reads and edits the manifest's `checks` array — the
// same array the gauntlet runs and `sidecar::harness::apply` ARMS. Arming a NEW
// check (a fresh command → the gauntlet spawns it) stays on the hardened,
// containment-defended `apply::write_merge_manifest` path — never here. THESE
// helpers only READ the armed set and EDIT existing entries (disable / retarget /
// remove), where the risk is not a new execution sink but corrupting a manifest,
// so they mirror the policy writer's posture: server-resolved path, atomic write,
// and a HARD error on a malformed manifest (never clobber the user's config).

/// One armed structure-lock check as the Checks Manager lists + edits it — the
/// on-disk `checks[]` entry shape (`kind`/`command` un-enumerated wire strings the
/// web casts). Distinct from the runtime `PlannedCheck` (which drops disabled
/// entries): the manager shows EVERY check, including disabled ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "ArmedCheckFile.ts"))]
pub struct ArmedCheckFile {
    pub name: String,
    /// `lint-plugin` | `dependency-cruiser` | … (validated at arm/edit time).
    pub kind: String,
    /// The exact command line the gauntlet spawns (whitespace-split).
    pub command: String,
    /// Whether the check participates in the gate (absent ⇒ `true`).
    pub enabled: bool,
    /// Per-check wall-clock timeout in ms (`timeoutMs`); `None` ⇒ the runner default.
    pub timeout_ms: Option<u64>,
    /// Informational tool config path, when the entry declares one.
    pub config_path: Option<String>,
    /// Drift-v1 (T15): the `conventionFingerprint` of the convention a COMPILED
    /// check verifies — the join key an EnforceRun uses to attribute site counts
    /// back to a `ConventionDrift` record. Serde-additive: absent on every existing
    /// manifest and on plain hardening checks, so old files load with `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub convention_fingerprint: Option<String>,
}

/// Read one `checks[]` entry leniently: skip any entry missing the three required
/// fields (a malformed entry never sinks the list — mirrors the runtime planner).
fn armed_check_from_value(v: &Value) -> Option<ArmedCheckFile> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    Some(ArmedCheckFile {
        name: s("name")?,
        kind: s("kind")?,
        command: s("command")?,
        // Absent / non-bool `enabled` reads as ON (the runtime planner's default).
        enabled: v.get("enabled").and_then(Value::as_bool) != Some(false),
        timeout_ms: v.get("timeoutMs").and_then(Value::as_u64),
        config_path: s("configPath"),
        convention_fingerprint: s("conventionFingerprint"),
    })
}

/// Read the active project's armed checks for the manager UI. Lenient like the
/// policy reader: an absent / malformed manifest or a non-array `checks` yields an
/// empty list (nothing armed), never an error — the manager opens on a blank slate.
pub fn read_armed_checks(project_path: &str) -> Vec<ArmedCheckFile> {
    let path = manifest_file(std::path::Path::new(project_path));
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let root: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                target: "nightcore::checks_manager",
                error = %e,
                "malformed .nightcore/harness.json; showing no armed checks"
            );
            return Vec::new();
        }
    };
    root.get("checks")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(armed_check_from_value).collect())
        .unwrap_or_default()
}

/// Load the manifest as a mutable root object, run `edit` over its `checks` array,
/// persist atomically, and return the re-read armed list. A malformed / non-object
/// manifest, or a non-array `checks`, is a HARD error (there is no safely-mergeable
/// intent) — the file is preserved for the user to fix, exactly like the policy
/// writer. Every other root key and every unknown per-check key survives verbatim.
fn mutate_armed_checks(
    project_path: &str,
    edit: impl FnOnce(&mut Vec<Value>) -> Result<(), String>,
) -> Result<Vec<ArmedCheckFile>, String> {
    let path = manifest_file(std::path::Path::new(project_path));
    let mut root = load_manifest_for_merge(&path, "editing checks")?;
    let root_map = root
        .as_object_mut()
        .expect("load_manifest_for_merge guarantees a JSON object");

    let mut checks: Vec<Value> = match root_map.remove("checks") {
        Some(Value::Array(items)) => items,
        None => Vec::new(),
        // A present, non-array `checks` can't be safely merged — refuse rather than
        // silently discard whatever the user has there.
        Some(_) => {
            return Err(format!(
                "{} has a non-array `checks`; fix it by hand before editing checks",
                path.display()
            ))
        }
    };

    edit(&mut checks)?;

    root_map.insert("checks".to_string(), Value::Array(checks));
    let json = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("failed to serialize harness manifest: {e}"))?;
    persist_manifest(&path, &json)?;
    Ok(read_armed_checks(project_path))
}

/// Find the mutable `checks[]` entry with the given `name`, or `None`.
fn find_check_mut<'a>(checks: &'a mut [Value], name: &str) -> Option<&'a mut Value> {
    checks
        .iter_mut()
        .find(|c| c.get("name").and_then(Value::as_str) == Some(name))
}

/// Enable or disable an existing armed check by name (merge-by-key: only `enabled`
/// is touched; the command, kind, timeout, and any unknown keys survive).
pub fn set_check_enabled(
    project_path: &str,
    name: &str,
    enabled: bool,
) -> Result<Vec<ArmedCheckFile>, String> {
    mutate_armed_checks(project_path, |checks| {
        let entry =
            find_check_mut(checks, name).ok_or_else(|| format!("no armed check named `{name}`"))?;
        entry
            .as_object_mut()
            .ok_or_else(|| format!("armed check `{name}` is not an object"))?
            .insert("enabled".to_string(), json!(enabled));
        Ok(())
    })
}

/// Remove an existing armed check by name (disarm it entirely).
pub fn remove_check(project_path: &str, name: &str) -> Result<Vec<ArmedCheckFile>, String> {
    mutate_armed_checks(project_path, |checks| {
        let before = checks.len();
        checks.retain(|c| c.get("name").and_then(Value::as_str) != Some(name));
        if checks.len() == before {
            return Err(format!("no armed check named `{name}`"));
        }
        Ok(())
    })
}

/// Edit an existing armed check identified by `original_name`. Merge-by-key: the
/// known fields (name/kind/command/enabled + timeoutMs/configPath set-or-remove)
/// are updated in place; every unknown per-check key survives. Renaming to a name
/// another check already uses is rejected (names are the merge identity).
pub fn update_check(
    project_path: &str,
    original_name: &str,
    updated: &ArmedCheckFile,
) -> Result<Vec<ArmedCheckFile>, String> {
    mutate_armed_checks(project_path, |checks| {
        // A rename that collides with a DIFFERENT existing check is rejected.
        if updated.name != original_name
            && checks
                .iter()
                .any(|c| c.get("name").and_then(Value::as_str) == Some(updated.name.as_str()))
        {
            return Err(format!(
                "an armed check named `{}` already exists",
                updated.name
            ));
        }
        let entry = find_check_mut(checks, original_name)
            .ok_or_else(|| format!("no armed check named `{original_name}`"))?
            .as_object_mut()
            .ok_or_else(|| format!("armed check `{original_name}` is not an object"))?;
        entry.insert("name".to_string(), json!(updated.name));
        entry.insert("kind".to_string(), json!(updated.kind));
        entry.insert("command".to_string(), json!(updated.command));
        entry.insert("enabled".to_string(), json!(updated.enabled));
        match updated.timeout_ms {
            Some(ms) => {
                entry.insert("timeoutMs".to_string(), json!(ms));
            }
            None => {
                entry.remove("timeoutMs");
            }
        }
        match &updated.config_path {
            Some(p) => {
                entry.insert("configPath".to_string(), json!(p));
            }
            None => {
                entry.remove("configPath");
            }
        }
        // Drift-v1 (T15): the convention join key follows the same set-or-remove merge
        // as the other optional fields, so an edit preserves (or clears) a compiled
        // drift check's `conventionFingerprint`.
        match &updated.convention_fingerprint {
            Some(fp) => {
                entry.insert("conventionFingerprint".to_string(), json!(fp));
            }
            None => {
                entry.remove("conventionFingerprint");
            }
        }
        Ok(())
    })
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
                "allowExecSinks": ["package.json"],
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
        assert_eq!(file.allow_exec_sinks, vec!["package.json"]);
        assert_eq!(
            file.diff_budget,
            Some(PolicyDiffBudget {
                max_changed_lines: Some(400),
                max_changed_files: Some(20),
            })
        );
    }

    #[test]
    fn allow_exec_sinks_only_policy_still_reads_as_manifest_exists_and_enabled() {
        // The web governance banner's fail-safe gap (#308): a manifest armed
        // EXCLUSIVELY via `policy.allowExecSinks` must round-trip through this
        // UI-facing reader too, not just the runtime resolver
        // (`store::harness_policy::read_policy`) — otherwise the web's "armed"
        // signal can't see it no matter how `harnessPolicyHasRules` is written.
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(
            &tmp,
            r#"{ "policy": { "allowExecSinks": [".github/workflows/**"] } }"#,
        );
        let file = read_policy_file(&root_of(&tmp));
        assert!(file.manifest_exists);
        assert!(file.enabled);
        assert_eq!(file.allow_exec_sinks, vec![".github/workflows/**"]);
        assert!(file.protected_paths.is_empty());
        assert!(file.deny_bash_patterns.is_empty());
        assert!(file.deny_read_paths.is_empty());
        assert!(file.disallowed_tools.is_empty());
        assert!(file.allow_tools.is_empty());
        assert!(file.ask_tools.is_empty());
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

    // --- schemaVersion stamp (portable lock, #134 PR 3) ---------------------

    #[test]
    fn schema_version_stamp_is_additive_at_every_level() {
        // Cloned from `unknown_keys_survive_a_round_trip_at_every_level`: stamping
        // `schemaVersion` must leave `checks`, `policy` (incl. unknown policy keys),
        // and unknown root siblings verbatim — it is a one-key additive root stamp.
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(
            &tmp,
            r#"{
              "checks": [{ "name": "lint", "kind": "lint-plugin", "command": "npx eslint ." }],
              "rootExtra": { "nested": true },
              "policy": { "enabled": true, "futureKnob": ["keep-me"] }
            }"#,
        );
        let stamped = stamp_live_manifest(&root_of(&tmp)).expect("stamp");

        // The returned text (the bundle copy) carries the stamp.
        let returned: Value = serde_json::from_str(&stamped).expect("returned text parses");
        assert_eq!(returned["schemaVersion"], HARNESS_SCHEMA_VERSION);

        // On disk: the stamp landed and every prior key survived untouched.
        let value = read_manifest_value(&tmp);
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["checks"][0]["name"], "lint");
        assert_eq!(value["rootExtra"]["nested"], true);
        assert_eq!(value["policy"]["enabled"], true);
        assert_eq!(value["policy"]["futureKnob"][0], "keep-me");
    }

    #[test]
    fn schema_version_stamp_is_idempotent_on_disk() {
        // A re-export must NOT rewrite an already-stamped live manifest (the on-disk
        // bytes stay identical) — re-export's only diff is in the staging dir.
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(
            &tmp,
            r#"{ "checks": [{ "name": "lint", "kind": "lint-plugin", "command": "npx eslint ." }] }"#,
        );
        stamp_live_manifest(&root_of(&tmp)).expect("first stamp");
        let after_first =
            std::fs::read_to_string(tmp.path().join(".nightcore/harness.json")).expect("read");
        // Second stamp: already at the current version ⇒ no write.
        let returned = stamp_live_manifest(&root_of(&tmp)).expect("second stamp");
        let after_second =
            std::fs::read_to_string(tmp.path().join(".nightcore/harness.json")).expect("read");
        assert_eq!(
            after_first, after_second,
            "re-stamping an already-stamped manifest leaves the file byte-identical"
        );
        // The returned bundle text still reflects the stamped manifest.
        assert_eq!(
            serde_json::from_str::<Value>(&returned).unwrap()["schemaVersion"],
            1
        );
    }

    #[test]
    fn schema_version_stamp_creates_an_absent_manifest() {
        let tmp = TempDir::new().expect("temp dir");
        let stamped = stamp_live_manifest(&root_of(&tmp)).expect("stamp creates");
        assert_eq!(
            serde_json::from_str::<Value>(&stamped).unwrap()["schemaVersion"],
            1
        );
        let value = read_manifest_value(&tmp);
        assert_eq!(value["schemaVersion"], 1);
    }

    #[test]
    fn schema_version_stamp_refuses_a_malformed_manifest() {
        // Same never-clobber posture as the policy/checks writers: a malformed manifest
        // errors and is preserved byte-for-byte rather than being reset into the bundle.
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(&tmp, "{ not json");
        let err = stamp_live_manifest(&root_of(&tmp)).expect_err("must not clobber");
        assert!(err.contains("not valid JSON"), "got: {err}");
        let raw =
            std::fs::read_to_string(tmp.path().join(".nightcore/harness.json")).expect("kept");
        assert_eq!(raw, "{ not json");
    }

    // --- armed checks (Checks Manager) --------------------------------------

    const TWO_CHECKS: &str = r#"{
      "checks": [
        { "name": "lint", "kind": "lint-plugin", "command": "npx eslint .", "timeoutMs": 60000 },
        { "name": "arch", "kind": "dependency-cruiser", "command": "npx depcruise src", "enabled": false, "extraKey": 7 }
      ],
      "policy": { "enabled": true },
      "rootExtra": true
    }"#;

    #[test]
    fn read_armed_checks_lists_every_check_including_disabled() {
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(&tmp, TWO_CHECKS);
        let checks = read_armed_checks(&root_of(&tmp));
        assert_eq!(checks.len(), 2, "disabled checks are listed too");
        assert_eq!(checks[0].name, "lint");
        assert!(checks[0].enabled, "absent/true enabled reads on");
        assert_eq!(checks[0].timeout_ms, Some(60000));
        assert_eq!(checks[1].name, "arch");
        assert!(!checks[1].enabled, "explicit false reads off");
        assert!(checks[1].timeout_ms.is_none());
    }

    #[test]
    fn read_armed_checks_absent_or_malformed_is_empty() {
        let tmp = TempDir::new().expect("temp dir");
        assert!(
            read_armed_checks(&root_of(&tmp)).is_empty(),
            "absent ⇒ empty"
        );
        write_manifest(&tmp, "{ not json");
        assert!(
            read_armed_checks(&root_of(&tmp)).is_empty(),
            "malformed ⇒ empty, never an error"
        );
    }

    #[test]
    fn set_check_enabled_flips_one_and_preserves_the_rest() {
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(&tmp, TWO_CHECKS);
        let after = set_check_enabled(&root_of(&tmp), "arch", true).expect("enable");
        assert!(after.iter().find(|c| c.name == "arch").unwrap().enabled);
        // Siblings + unknown keys + other root keys survive verbatim.
        let value = read_manifest_value(&tmp);
        assert_eq!(
            value["checks"][1]["extraKey"], 7,
            "unknown per-check key kept"
        );
        assert_eq!(
            value["checks"][0]["command"], "npx eslint .",
            "sibling untouched"
        );
        assert_eq!(value["rootExtra"], true, "root sibling kept");
        assert_eq!(value["policy"]["enabled"], true, "policy block kept");
    }

    #[test]
    fn set_check_enabled_unknown_name_errors() {
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(&tmp, TWO_CHECKS);
        let err = set_check_enabled(&root_of(&tmp), "ghost", false).expect_err("no such check");
        assert!(err.contains("no armed check named `ghost`"), "got: {err}");
    }

    #[test]
    fn remove_check_drops_it() {
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(&tmp, TWO_CHECKS);
        let after = remove_check(&root_of(&tmp), "lint").expect("remove");
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].name, "arch");
        // Removing an absent check errors (nothing removed).
        assert!(remove_check(&root_of(&tmp), "lint").is_err());
    }

    #[test]
    fn update_check_edits_in_place_and_can_retarget_and_clear_timeout() {
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(&tmp, TWO_CHECKS);
        let updated = ArmedCheckFile {
            name: "lint".into(),
            kind: "lint-plugin".into(),
            command: "npx eslint . --max-warnings 0".into(),
            enabled: false,
            timeout_ms: None, // clears the existing timeoutMs
            config_path: Some(".eslintrc".into()),
            convention_fingerprint: None,
        };
        let after = update_check(&root_of(&tmp), "lint", &updated).expect("update");
        let lint = after.iter().find(|c| c.name == "lint").unwrap();
        assert_eq!(lint.command, "npx eslint . --max-warnings 0");
        assert!(!lint.enabled);
        assert!(lint.timeout_ms.is_none(), "timeoutMs cleared");
        assert_eq!(lint.config_path.as_deref(), Some(".eslintrc"));
        let value = read_manifest_value(&tmp);
        assert!(
            value["checks"][0].get("timeoutMs").is_none(),
            "the timeoutMs key is removed, not zeroed"
        );
    }

    #[test]
    fn update_check_sets_and_clears_the_convention_fingerprint() {
        // Drift-v1 (T15): editing a check sets the `conventionFingerprint` when present
        // and REMOVES the key when cleared (same set-or-remove merge as timeoutMs), so a
        // compiled drift check keeps its join key across edits.
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(&tmp, TWO_CHECKS);
        let set = ArmedCheckFile {
            name: "lint".into(),
            kind: "lint-meta".into(),
            command: "bun run lint:meta".into(),
            enabled: true,
            timeout_ms: None,
            config_path: None,
            convention_fingerprint: Some("a1b2c3d4e5f60718".into()),
        };
        let after = update_check(&root_of(&tmp), "lint", &set).expect("set fingerprint");
        let lint = after.iter().find(|c| c.name == "lint").unwrap();
        assert_eq!(
            lint.convention_fingerprint.as_deref(),
            Some("a1b2c3d4e5f60718")
        );

        // Now clear it — the key must be removed, not zeroed.
        let cleared = ArmedCheckFile {
            convention_fingerprint: None,
            ..set
        };
        let after = update_check(&root_of(&tmp), "lint", &cleared).expect("clear fingerprint");
        let lint = after.iter().find(|c| c.name == "lint").unwrap();
        assert!(lint.convention_fingerprint.is_none());
        let value = read_manifest_value(&tmp);
        assert!(
            value["checks"][0].get("conventionFingerprint").is_none(),
            "the conventionFingerprint key is removed, not left behind"
        );
    }

    #[test]
    fn update_check_rename_collision_is_rejected() {
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(&tmp, TWO_CHECKS);
        let renamed = ArmedCheckFile {
            name: "arch".into(), // collides with the other check
            kind: "lint-plugin".into(),
            command: "npx eslint .".into(),
            enabled: true,
            timeout_ms: None,
            config_path: None,
            convention_fingerprint: None,
        };
        let err = update_check(&root_of(&tmp), "lint", &renamed).expect_err("collision");
        assert!(err.contains("already exists"), "got: {err}");
    }

    #[test]
    fn mutating_a_malformed_manifest_refuses_the_write() {
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(&tmp, "{ not json");
        let err = remove_check(&root_of(&tmp), "lint").expect_err("must not clobber");
        assert!(err.contains("not valid JSON"), "got: {err}");
        let raw =
            std::fs::read_to_string(tmp.path().join(".nightcore/harness.json")).expect("kept");
        assert_eq!(raw, "{ not json", "the broken file is preserved");
    }

    #[test]
    fn armed_check_reads_convention_fingerprint_additively() {
        // Drift-v1 (T15): a compiled check carries the origin convention's fingerprint;
        // an old-style check without the key loads with `None` (serde-additive).
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(
            &tmp,
            r#"{
              "checks": [
                { "name": "drift", "kind": "lint-meta", "command": "bun run lint:meta", "conventionFingerprint": "a1b2c3d4e5f60718" },
                { "name": "legacy", "kind": "lint-plugin", "command": "npx eslint ." }
              ]
            }"#,
        );
        let checks = read_armed_checks(&root_of(&tmp));
        let drift = checks.iter().find(|c| c.name == "drift").unwrap();
        assert_eq!(
            drift.convention_fingerprint.as_deref(),
            Some("a1b2c3d4e5f60718")
        );
        let legacy = checks.iter().find(|c| c.name == "legacy").unwrap();
        assert!(
            legacy.convention_fingerprint.is_none(),
            "a check without the key loads with None"
        );
    }

    #[test]
    fn editing_a_check_preserves_its_convention_fingerprint() {
        // The origin fingerprint is immutable metadata the manager never edits — a
        // merge-by-key write (disable) must leave it verbatim on disk.
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(
            &tmp,
            r#"{ "checks": [ { "name": "drift", "kind": "lint-meta", "command": "bun run lint:meta", "conventionFingerprint": "a1b2c3d4e5f60718" } ] }"#,
        );
        set_check_enabled(&root_of(&tmp), "drift", false).expect("disable");
        let value = read_manifest_value(&tmp);
        assert_eq!(
            value["checks"][0]["conventionFingerprint"],
            "a1b2c3d4e5f60718"
        );
    }

    #[test]
    fn edited_check_is_honored_by_the_runtime_gauntlet() {
        // The manager writes; the gauntlet reads: disabling a check drops it from the
        // run, and a re-enabled one runs again.
        let tmp = TempDir::new().expect("temp dir");
        write_manifest(
            &tmp,
            r#"{ "checks": [ { "name": "ok", "kind": "lint-plugin", "command": "sh -c true" } ] }"#,
        );
        set_check_enabled(&root_of(&tmp), "ok", false).expect("disable");
        let disabled = crate::workflow::gauntlet_project::run(tmp.path());
        assert!(disabled.checks.is_empty(), "a disabled check does not run");
        set_check_enabled(&root_of(&tmp), "ok", true).expect("enable");
        let enabled = crate::workflow::gauntlet_project::run(tmp.path());
        assert_eq!(enabled.checks.len(), 1, "the re-enabled check runs again");
    }
}
