//! Global + per-project settings (Phase 2).
//!
//! Settings live in Tauri's **app config dir** as `settings.json`: global defaults
//! plus a `projectOverrides` map keyed by project id. A patch with no `projectId`
//! shallow-merges into the global block; with a `projectId` it merges into that
//! project's override. Several fields persist now but aren't enforced until M2/M3
//! (the auto-loop, worktree cleanup, notifications) — the UI keeps them visible
//! and roadmap-badged.
//!
//! Held in managed Tauri state; commands take it as `State<'_, SettingsStore>`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

/// Global settings + per-project overrides. Field names mirror the Phase 2
/// contract and serialize camelCase for the TS bridge and on-disk JSON.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub default_model: String,
    pub default_effort: String,
    /// 1..=6. Persists now; the M2 loop is not yet enforcing it.
    pub max_concurrency: u8,
    /// "bypass" | "auto-accept" | "ask" | "plan" (M4.7 §A1). Maps to the engine's
    /// SDK `permissionMode` via [`sdk_permission_mode`]. Default is `bypass` (an
    /// autonomous studio runs without prompts; a per-task override re-enables them).
    pub permission_mode: String,
    /// M2 toggle: remove a task's worktree after it merges. Read at
    /// `merge.rs`/`coordinator.rs`; editable from the Worktrees settings page.
    pub cleanup_worktrees: bool,
    /// M3 toggle; persists only.
    pub notify_on_complete: bool,
    /// M4.6: the default run mode new tasks inherit — `"main"` (default) or
    /// `"worktree"`. Per-project overridable. A new task's `run_mode` is this value
    /// unless the create call passes an explicit one.
    #[serde(default = "default_run_mode_value")]
    pub default_run_mode: String,
    /// SDK-guardrails: the default max conversation turns new tasks inherit when
    /// they don't carry an explicit per-task ceiling. `None` ⇒ fall through to the
    /// engine's `@nightcore/config` default (200). Per-project overridable.
    /// Serde-additive: a settings file written before this field loads as `None`.
    #[serde(default)]
    pub max_turns: Option<u32>,
    /// SDK-guardrails: the default hard cost ceiling (USD) new tasks inherit.
    /// `None` ⇒ uncapped (the engine's config default applies). Per-project
    /// overridable. Serde-additive: legacy settings load this as `None`.
    #[serde(default)]
    pub max_budget_usd: Option<f64>,
    /// Per-project overrides keyed by project id.
    pub project_overrides: HashMap<String, SettingsOverride>,
}

/// The serde default for `default_run_mode` (a legacy settings file without the
/// field loads as `"main"`).
fn default_run_mode_value() -> String {
    "main".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            // SDK long ids (the value sent on the wire); see `canonical_model_id`
            // for the legacy short-id fallback so old settings files still resolve.
            default_model: "claude-opus-4-8".to_string(),
            default_effort: "medium".to_string(),
            max_concurrency: 3,
            // M4.7 §A1: bypass by default — new tasks run unattended with no
            // approval prompts. A per-task override re-enables prompting.
            permission_mode: "bypass".to_string(),
            cleanup_worktrees: true,
            notify_on_complete: false,
            default_run_mode: default_run_mode_value(),
            // SDK-guardrails: no Settings-level ceiling by default — a new task
            // inherits the engine's `@nightcore/config` default (maxTurns 200,
            // budget uncapped) until the user sets a knob here.
            max_turns: None,
            max_budget_usd: None,
            project_overrides: HashMap::new(),
        }
    }
}

/// A per-project override: any subset of the run-shaping fields. Absent fields
/// fall back to the global value.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsOverride {
    pub default_model: Option<String>,
    pub default_effort: Option<String>,
    pub max_concurrency: Option<u8>,
    pub permission_mode: Option<String>,
    /// M4.6: per-project default run mode (`"main"` | `"worktree"`).
    pub default_run_mode: Option<String>,
    /// SDK-guardrails: per-project default max-turns ceiling (overrides the global
    /// `max_turns` for this project's new tasks).
    #[serde(default)]
    pub max_turns: Option<u32>,
    /// SDK-guardrails: per-project default max-budget-USD ceiling.
    #[serde(default)]
    pub max_budget_usd: Option<f64>,
}

impl SettingsOverride {
    /// Apply the present fields of `patch` onto this override.
    fn apply_patch(&mut self, patch: &SettingsPatch) {
        if patch.default_model.is_some() {
            self.default_model = patch.default_model.clone();
        }
        if patch.default_effort.is_some() {
            self.default_effort = patch.default_effort.clone();
        }
        if patch.max_concurrency.is_some() {
            self.max_concurrency = patch.max_concurrency;
        }
        if patch.permission_mode.is_some() {
            self.permission_mode = patch.permission_mode.clone();
        }
        if patch.default_run_mode.is_some() {
            self.default_run_mode = patch.default_run_mode.clone();
        }
        if patch.max_turns.is_some() {
            self.max_turns = patch.max_turns;
        }
        if patch.max_budget_usd.is_some() {
            self.max_budget_usd = patch.max_budget_usd;
        }
    }

    fn is_empty(&self) -> bool {
        self.default_model.is_none()
            && self.default_effort.is_none()
            && self.max_concurrency.is_none()
            && self.permission_mode.is_none()
            && self.default_run_mode.is_none()
            && self.max_turns.is_none()
            && self.max_budget_usd.is_none()
    }
}

/// A partial update. A `projectId` targets a per-project override; otherwise the
/// patch merges into the global block. Every field optional.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub project_id: Option<String>,
    pub default_model: Option<String>,
    pub default_effort: Option<String>,
    pub max_concurrency: Option<u8>,
    pub permission_mode: Option<String>,
    pub cleanup_worktrees: Option<bool>,
    pub notify_on_complete: Option<bool>,
    /// M4.6: default run mode (`"main"` | `"worktree"`). With a `projectId` it lands
    /// in that project's override; without one, the global default.
    pub default_run_mode: Option<String>,
    /// SDK-guardrails: default max-turns ceiling. With a `projectId` it lands in
    /// that project's override; without one, the global default.
    pub max_turns: Option<u32>,
    /// SDK-guardrails: default max-budget-USD ceiling. With a `projectId` it lands
    /// in that project's override; without one, the global default.
    pub max_budget_usd: Option<f64>,
}

impl Settings {
    /// Shallow-merge `patch`. With a `projectId`, the run-shaping fields land in
    /// that project's override (global-only fields like `cleanup_worktrees` /
    /// `notify_on_complete` are ignored for an override target); without one, they
    /// merge into the global block.
    fn merge(&mut self, patch: SettingsPatch) {
        if let Some(project_id) = patch.project_id.clone() {
            let entry = self.project_overrides.entry(project_id.clone()).or_default();
            entry.apply_patch(&patch);
            if entry.is_empty() {
                self.project_overrides.remove(&project_id);
            }
            return;
        }
        if let Some(v) = patch.default_model {
            self.default_model = v;
        }
        if let Some(v) = patch.default_effort {
            self.default_effort = v;
        }
        if let Some(v) = patch.max_concurrency {
            self.max_concurrency = v;
        }
        if let Some(v) = patch.permission_mode {
            self.permission_mode = v;
        }
        if let Some(v) = patch.cleanup_worktrees {
            self.cleanup_worktrees = v;
        }
        if let Some(v) = patch.notify_on_complete {
            self.notify_on_complete = v;
        }
        if let Some(v) = patch.default_run_mode {
            self.default_run_mode = v;
        }
        // SDK-guardrails: a present value sets the global ceiling. Like `model`,
        // serde flattens absent and explicit-null to the same `None`, so a global
        // patch can SET a ceiling but not clear it back to inherit — the only
        // observable behavior the UI relies on (the inputs always send a value or
        // omit the key entirely).
        if patch.max_turns.is_some() {
            self.max_turns = patch.max_turns;
        }
        if patch.max_budget_usd.is_some() {
            self.max_budget_usd = patch.max_budget_usd;
        }
    }
}

/// In-memory settings plus the config dir they persist to.
pub struct SettingsStore {
    settings: Mutex<Settings>,
    config_dir: PathBuf,
}

impl SettingsStore {
    /// Load `<config_dir>/settings.json`, falling back to defaults when missing or
    /// unparsable. Creates the dir if needed.
    pub fn load_from(config_dir: PathBuf) -> Self {
        if let Err(e) = std::fs::create_dir_all(&config_dir) {
            tracing::warn!(target: "nightcore::settings", dir = %config_dir.display(), error = %e, "failed to create settings dir");
        }
        let settings = read_settings(&config_dir.join("settings.json")).unwrap_or_default();
        Self {
            settings: Mutex::new(settings),
            config_dir,
        }
    }

    /// A snapshot of the current settings.
    pub fn get(&self) -> Settings {
        self.settings.lock().expect("settings store poisoned").clone()
    }

    /// The effective permission mode for a project (its override, else the global),
    /// mapped to the engine's SDK `permissionMode` (see [`sdk_permission_mode`]).
    pub fn sdk_permission_mode(&self, project_id: Option<&str>) -> String {
        let settings = self.get();
        let raw = project_id
            .and_then(|id| settings.project_overrides.get(id))
            .and_then(|ov| ov.permission_mode.clone())
            .unwrap_or(settings.permission_mode);
        sdk_permission_mode(&raw)
    }

    /// The effective default run mode for a project (its override, else the
    /// global), parsed to a [`RunMode`]. Fail-safe: an unrecognized value resolves
    /// to `Main` (worktrees are opt-in, never silently auto-isolated).
    pub fn default_run_mode(&self, project_id: Option<&str>) -> crate::task::RunMode {
        let settings = self.get();
        let raw = project_id
            .and_then(|id| settings.project_overrides.get(id))
            .and_then(|ov| ov.default_run_mode.clone())
            .unwrap_or(settings.default_run_mode);
        parse_run_mode(&raw)
    }

    /// The effective default model for a project (its override, else the global),
    /// canonicalized to an SDK long id (see [`canonical_model_id`]). This is the
    /// value `create_task` stamps onto a task whose create call omits a model, so
    /// the Settings default is what a new task actually runs with (P0).
    pub fn default_model(&self, project_id: Option<&str>) -> String {
        let settings = self.get();
        let raw = project_id
            .and_then(|id| settings.project_overrides.get(id))
            .and_then(|ov| ov.default_model.clone())
            .unwrap_or(settings.default_model);
        canonical_model_id(&raw)
    }

    /// The effective default reasoning effort for a project (its override, else the
    /// global). Effort values already match the SDK levels, so no mapping is needed.
    pub fn default_effort(&self, project_id: Option<&str>) -> String {
        let settings = self.get();
        project_id
            .and_then(|id| settings.project_overrides.get(id))
            .and_then(|ov| ov.default_effort.clone())
            .unwrap_or(settings.default_effort)
    }

    /// The effective default max-turns ceiling for a project (its override, else
    /// the global). `None` ⇒ no Settings ceiling, so `create_task` leaves the
    /// task's `max_turns` as `None` and the engine's `@nightcore/config` default
    /// (200) applies. Mirrors [`default_model`](Self::default_model)'s
    /// project-override → global resolution.
    pub fn default_max_turns(&self, project_id: Option<&str>) -> Option<u32> {
        let settings = self.get();
        project_id
            .and_then(|id| settings.project_overrides.get(id))
            .and_then(|ov| ov.max_turns)
            .or(settings.max_turns)
    }

    /// The effective default max-budget-USD ceiling for a project (its override,
    /// else the global). `None` ⇒ uncapped at the Settings level; the engine's
    /// config default applies. Mirrors [`default_max_turns`](Self::default_max_turns).
    pub fn default_max_budget_usd(&self, project_id: Option<&str>) -> Option<f64> {
        let settings = self.get();
        project_id
            .and_then(|id| settings.project_overrides.get(id))
            .and_then(|ov| ov.max_budget_usd)
            .or(settings.max_budget_usd)
    }

    /// Apply a patch, persist, and return the merged settings.
    fn update(&self, patch: SettingsPatch) -> Result<Settings, String> {
        let mut guard = self.settings.lock().expect("settings store poisoned");
        guard.merge(patch);
        let snapshot = guard.clone();
        write_settings(&self.config_dir.join("settings.json"), &snapshot)?;
        Ok(snapshot)
    }

    /// Test-only seam: apply a patch to an in-memory store (used by other modules'
    /// tests — e.g. `task::build_new_task` — to set up Settings defaults without
    /// reaching into the private [`update`](Self::update)).
    #[cfg(test)]
    pub(crate) fn update_for_test(&self, patch: SettingsPatch) -> Result<Settings, String> {
        self.update(patch)
    }
}

/// Map a Nightcore permission-mode setting to the engine's SDK `permissionMode`
/// (M4.7 §A1):
///   `bypass` → `bypassPermissions` (no prompts; the engine sets
///   `allowDangerouslySkipPermissions`), `auto-accept` → `acceptEdits`,
///   `ask` → `default` (prompt on dangerous), `plan` → `plan`.
/// An unrecognized value resolves to `bypassPermissions` — the studio's default
/// is unattended operation (the autonomous-studio choice; a task that wants
/// prompts sets `ask`/`plan` explicitly).
pub fn sdk_permission_mode(raw: &str) -> String {
    match raw {
        "bypass" => "bypassPermissions",
        "auto-accept" => "acceptEdits",
        "plan" => "plan",
        "ask" => "default",
        _ => "bypassPermissions",
    }
    .to_string()
}

/// Canonicalize a stored model id to an SDK long id (the value the engine sends
/// on the wire). Settings now persist long ids directly, but a settings file
/// written before P0 holds a SHORT id (`opus-4.8` / `sonnet-4.6` / `haiku-4.5`);
/// map those by family so legacy config still resolves to a valid SDK model. An
/// already-canonical or unknown id passes through unchanged (the SDK accepts any
/// model string; an unrecognized custom id is the user's own choice).
///
/// This is the single short→long map on the Rust side; the web stores long ids
/// via `MODEL_OPTIONS`, so this only fires for pre-P0 persisted settings.
pub fn canonical_model_id(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("claude-") {
        return raw.to_string();
    }
    match () {
        _ if lower.contains("opus") => "claude-opus-4-8",
        _ if lower.contains("sonnet") => "claude-sonnet-4-6",
        _ if lower.contains("haiku") => "claude-haiku-4-5",
        _ if lower.contains("fable") => "claude-fable-5",
        _ => return raw.to_string(),
    }
    .to_string()
}

/// Parse a `default_run_mode` setting string into a [`RunMode`]. Fail-safe: an
/// unrecognized value resolves to `Main` so worktrees are never silently the
/// default. Reuses the enum's serde mapping so accepted strings can't drift.
fn parse_run_mode(raw: &str) -> crate::task::RunMode {
    match raw {
        "worktree" => crate::task::RunMode::Worktree,
        _ => crate::task::RunMode::Main,
    }
}

fn read_settings(path: &Path) -> Option<Settings> {
    let raw = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&raw) {
        Ok(value) => Some(value),
        Err(e) => {
            tracing::warn!(target: "nightcore::settings", path = %path.display(), error = %e, "cannot parse settings; using defaults");
            None
        }
    }
}

fn write_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("failed to write {}: {e}", path.display()))
}

/// Read-only application metadata for the About page. Sourced from build-time
/// constants (Cargo package version + a compiled-in repo URL) so the UI shows
/// real values instead of hardcoded literals.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// The app version (the `[package] version` in `Cargo.toml`).
    pub version: String,
    /// The canonical source repository URL.
    pub repository: String,
}

/// The repository URL, compiled in (no fake `github.com/you` literal in the UI).
const REPOSITORY_URL: &str = "https://github.com/Shironex/nightcore";

// --- Commands ---------------------------------------------------------------

/// Real application metadata for the About page (version + repo URL), sourced from
/// build-time constants rather than UI literals.
#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        repository: REPOSITORY_URL.to_string(),
    }
}

/// The current settings (global + per-project overrides).
#[tauri::command]
pub fn get_settings(store: State<'_, SettingsStore>) -> Result<Settings, String> {
    Ok(store.get())
}

/// Shallow-merge a patch into the global block, or — when `projectId` is set —
/// into that project's override. Returns the merged settings. A global
/// `maxConcurrency` change is also applied to the live slot pool so the auto-loop
/// honors it immediately (not just on next launch).
#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    patch: SettingsPatch,
) -> Result<Settings, String> {
    // A global (no projectId) maxConcurrency change resizes the live pool.
    let resize = patch.project_id.is_none().then_some(patch.max_concurrency).flatten();
    let merged = store.update(patch)?;
    if let Some(n) = resize {
        crate::m2::coordinator::set_max_concurrency(&app, n.max(1) as usize);
    }
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn temp_store() -> (SettingsStore, TempDir) {
        let tmp = TempDir::new().expect("create temp dir");
        let store = SettingsStore::load_from(tmp.path().join("config"));
        (store, tmp)
    }

    #[test]
    fn defaults_are_the_contract_values() {
        let s = Settings::default();
        // P0: defaults persist SDK long ids so a new task runs with a valid model.
        assert_eq!(s.default_model, "claude-opus-4-8");
        assert_eq!(s.max_concurrency, 3);
        // M4.7 §A1: bypass is the studio default.
        assert_eq!(s.permission_mode, "bypass");
        assert!(s.cleanup_worktrees);
        assert!(!s.notify_on_complete);
        assert!(s.project_overrides.is_empty());
    }

    #[test]
    fn canonical_model_id_maps_legacy_short_ids() {
        // P0: a pre-P0 settings file holds short ids; they resolve to SDK long ids.
        assert_eq!(canonical_model_id("opus-4.8"), "claude-opus-4-8");
        assert_eq!(canonical_model_id("sonnet-4.6"), "claude-sonnet-4-6");
        assert_eq!(canonical_model_id("haiku-4.5"), "claude-haiku-4-5");
        // Already-canonical ids pass through unchanged.
        assert_eq!(canonical_model_id("claude-opus-4-8"), "claude-opus-4-8");
        assert_eq!(
            canonical_model_id("claude-haiku-4-5-20251001"),
            "claude-haiku-4-5-20251001"
        );
        // An unknown custom id is the user's choice — passed through verbatim.
        assert_eq!(canonical_model_id("my-custom-model"), "my-custom-model");
    }

    #[test]
    fn default_model_resolves_project_then_global_as_long_id() {
        let (store, _tmp) = temp_store();
        // Global default is already a long id.
        assert_eq!(store.default_model(None), "claude-opus-4-8");
        assert_eq!(store.default_effort(None), "medium");

        // A per-project override wins for that project; effort falls back to global.
        store
            .update(
                serde_json::from_str(r#"{"projectId":"p1","defaultModel":"claude-sonnet-4-6"}"#)
                    .unwrap(),
            )
            .expect("update");
        assert_eq!(store.default_model(Some("p1")), "claude-sonnet-4-6");
        assert_eq!(store.default_model(Some("other")), "claude-opus-4-8");
        assert_eq!(store.default_effort(Some("p1")), "medium");
    }

    #[test]
    fn default_model_canonicalizes_a_legacy_persisted_short_id() {
        // A settings file from before P0 stored `opus-4.8`; the resolver still hands
        // back a valid SDK long id so the legacy default keeps working.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"opus-4.8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","theme":"cosmic",
            "cleanupWorktrees":true,"notifyOnComplete":false,"projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();

        let store = SettingsStore::load_from(dir);
        assert_eq!(store.default_model(None), "claude-opus-4-8");
    }

    #[test]
    fn global_patch_merges_and_round_trips() {
        let (store, tmp) = temp_store();
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"maxConcurrency":5,"defaultModel":"sonnet-4.6"}"#).unwrap();
        let merged = store.update(patch).expect("update");
        assert_eq!(merged.max_concurrency, 5);
        assert_eq!(merged.default_model, "sonnet-4.6");
        // Untouched fields keep their defaults.
        assert_eq!(merged.permission_mode, "bypass");

        // Persisted: a fresh store reloads the merged values.
        let reloaded = SettingsStore::load_from(tmp.path().join("config"));
        assert_eq!(reloaded.get().max_concurrency, 5);
        assert_eq!(reloaded.get().default_model, "sonnet-4.6");
    }

    #[test]
    fn project_patch_writes_an_override_not_the_global() {
        let (store, _tmp) = temp_store();
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"projectId":"proj-1","defaultModel":"haiku-4.5"}"#).unwrap();
        let merged = store.update(patch).expect("update");

        // Global default is unchanged; the override carries the project-scoped value.
        assert_eq!(merged.default_model, "claude-opus-4-8");
        let ov = merged.project_overrides.get("proj-1").expect("override exists");
        assert_eq!(ov.default_model.as_deref(), Some("haiku-4.5"));
        assert!(ov.default_effort.is_none(), "only the patched field is set");
    }

    #[test]
    fn maps_permission_modes_to_sdk() {
        // M4.7 §A1: the four UI modes map to their SDK equivalents.
        assert_eq!(sdk_permission_mode("bypass"), "bypassPermissions");
        assert_eq!(sdk_permission_mode("auto-accept"), "acceptEdits");
        assert_eq!(sdk_permission_mode("plan"), "plan");
        assert_eq!(sdk_permission_mode("ask"), "default");
        // An unrecognized value resolves to the studio default (bypass), never a
        // silent prompt-everything — the autonomous-studio choice.
        assert_eq!(sdk_permission_mode("garbage"), "bypassPermissions");
    }

    #[test]
    fn sdk_permission_mode_prefers_project_override() {
        let (store, _tmp) = temp_store();
        // Global default is bypass → bypassPermissions (M4.7 §A1).
        assert_eq!(store.sdk_permission_mode(None), "bypassPermissions");

        // A per-project override to `ask` wins for that project only — this is how
        // a single project opts OUT of global bypass back into prompting.
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"projectId":"p1","permissionMode":"ask"}"#).unwrap();
        store.update(patch).expect("update");
        assert_eq!(store.sdk_permission_mode(Some("p1")), "default");
        assert_eq!(store.sdk_permission_mode(Some("other")), "bypassPermissions");
        assert_eq!(store.sdk_permission_mode(None), "bypassPermissions");
    }

    #[test]
    fn default_run_mode_defaults_to_main_globally_and_per_project() {
        use crate::task::RunMode;
        let (store, _tmp) = temp_store();
        // The global default is `main` (worktrees opt-in).
        assert_eq!(Settings::default().default_run_mode, "main");
        assert_eq!(store.default_run_mode(None), RunMode::Main);
        assert_eq!(store.default_run_mode(Some("any")), RunMode::Main);

        // A global override flips it for every project without an own override.
        store
            .update(serde_json::from_str(r#"{"defaultRunMode":"worktree"}"#).unwrap())
            .expect("update");
        assert_eq!(store.default_run_mode(None), RunMode::Worktree);

        // A per-project override wins for that project only.
        store
            .update(
                serde_json::from_str(r#"{"projectId":"p1","defaultRunMode":"main"}"#).unwrap(),
            )
            .expect("update");
        assert_eq!(store.default_run_mode(Some("p1")), RunMode::Main);
        assert_eq!(store.default_run_mode(Some("other")), RunMode::Worktree);
    }

    #[test]
    fn default_run_mode_fails_safe_to_main_on_garbage() {
        use crate::task::RunMode;
        // An unrecognized stored value resolves to Main, never silently worktree.
        assert_eq!(parse_run_mode("garbage"), RunMode::Main);
        assert_eq!(parse_run_mode("main"), RunMode::Main);
        assert_eq!(parse_run_mode("worktree"), RunMode::Worktree);
    }

    #[test]
    fn legacy_settings_without_run_mode_loads_as_main() {
        // A settings.json from before M4.6 (no `defaultRunMode`) still parses and
        // defaults the field to "main" — existing config files aren't broken.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"opus-4.8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"auto-accept","theme":"cosmic",
            "cleanupWorktrees":true,"notifyOnComplete":false,"projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();

        let store = SettingsStore::load_from(dir);
        assert_eq!(store.get().default_run_mode, "main");
        assert_eq!(store.default_run_mode(None), crate::task::RunMode::Main);
    }

    #[test]
    fn settings_serializes_camel_case() {
        let value = serde_json::to_value(Settings::default()).unwrap();
        let obj = value.as_object().unwrap();
        for key in [
            "defaultModel",
            "maxConcurrency",
            "permissionMode",
            "cleanupWorktrees",
            "notifyOnComplete",
            "defaultRunMode",
            "maxTurns",
            "maxBudgetUsd",
            "projectOverrides",
        ] {
            assert!(obj.contains_key(key), "missing camelCase key {key}");
        }
    }

    #[test]
    fn guardrail_defaults_are_none_and_serde_additive() {
        // SDK-guardrails: with no Settings knob set, the resolvers return None so a
        // new task inherits the engine's `@nightcore/config` default.
        let s = Settings::default();
        assert!(s.max_turns.is_none(), "max_turns defaults to None (inherit)");
        assert!(
            s.max_budget_usd.is_none(),
            "max_budget_usd defaults to None (uncapped)"
        );

        // A settings.json from before the guardrails UI (no `maxTurns`/
        // `maxBudgetUsd`) still parses, defaulting both to None — the pinning
        // guarantee, so existing config files aren't broken.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"claude-opus-4-8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","cleanupWorktrees":true,
            "notifyOnComplete":false,"defaultRunMode":"main","projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();
        let store = SettingsStore::load_from(dir);
        assert!(store.get().max_turns.is_none());
        assert!(store.get().max_budget_usd.is_none());
        assert_eq!(store.default_max_turns(None), None);
        assert_eq!(store.default_max_budget_usd(None), None);
    }

    #[test]
    fn default_max_turns_resolves_project_then_global_then_none() {
        let (store, _tmp) = temp_store();
        // No knob set anywhere → None (inherit the config default).
        assert_eq!(store.default_max_turns(None), None);
        assert_eq!(store.default_max_budget_usd(None), None);

        // A global ceiling flips it for every project without an own override.
        store
            .update(
                serde_json::from_str(r#"{"maxTurns":150,"maxBudgetUsd":5.0}"#).unwrap(),
            )
            .expect("update");
        assert_eq!(store.default_max_turns(None), Some(150));
        assert_eq!(store.default_max_turns(Some("any")), Some(150));
        assert_eq!(store.default_max_budget_usd(Some("any")), Some(5.0));

        // A per-project override wins for that project only.
        store
            .update(
                serde_json::from_str(r#"{"projectId":"p1","maxTurns":50,"maxBudgetUsd":1.0}"#)
                    .unwrap(),
            )
            .expect("update");
        assert_eq!(store.default_max_turns(Some("p1")), Some(50));
        assert_eq!(store.default_max_budget_usd(Some("p1")), Some(1.0));
        // Another project still sees the global ceiling.
        assert_eq!(store.default_max_turns(Some("other")), Some(150));
        assert_eq!(store.default_max_budget_usd(Some("other")), Some(5.0));
    }

    #[test]
    fn guardrail_project_patch_writes_an_override_not_the_global() {
        let (store, _tmp) = temp_store();
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"projectId":"proj-1","maxTurns":42}"#).unwrap();
        let merged = store.update(patch).expect("update");

        // The global ceiling is untouched; the override carries the project value.
        assert!(merged.max_turns.is_none(), "global stays None");
        let ov = merged.project_overrides.get("proj-1").expect("override exists");
        assert_eq!(ov.max_turns, Some(42));
        assert!(ov.max_budget_usd.is_none(), "only the patched field is set");
    }
}
