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
    /// "auto-accept" | "plan" | "ask". Persists now; M3 — runtime still auto-denies.
    pub permission_mode: String,
    /// Accent/theme id.
    pub theme: String,
    /// M2 toggle; persists only.
    pub cleanup_worktrees: bool,
    /// M3 toggle; persists only.
    pub notify_on_complete: bool,
    /// Per-project overrides keyed by project id.
    pub project_overrides: HashMap<String, SettingsOverride>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_model: "opus-4.8".to_string(),
            default_effort: "medium".to_string(),
            max_concurrency: 3,
            permission_mode: "auto-accept".to_string(),
            theme: "cosmic".to_string(),
            cleanup_worktrees: true,
            notify_on_complete: false,
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
    }

    fn is_empty(&self) -> bool {
        self.default_model.is_none()
            && self.default_effort.is_none()
            && self.max_concurrency.is_none()
            && self.permission_mode.is_none()
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
    pub theme: Option<String>,
    pub cleanup_worktrees: Option<bool>,
    pub notify_on_complete: Option<bool>,
}

impl Settings {
    /// Shallow-merge `patch`. With a `projectId`, the run-shaping fields land in
    /// that project's override (global-only fields like `theme` are ignored for an
    /// override target); without one, they merge into the global block.
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
        if let Some(v) = patch.theme {
            self.theme = v;
        }
        if let Some(v) = patch.cleanup_worktrees {
            self.cleanup_worktrees = v;
        }
        if let Some(v) = patch.notify_on_complete {
            self.notify_on_complete = v;
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
    /// mapped to the engine's SDK `permissionMode`:
    ///   `auto-accept` → `acceptEdits`, `ask` → `default`, `plan` → `plan`.
    /// Fail-closed: an unknown value maps to `default` (prompt), never to
    /// `bypassPermissions`.
    pub fn sdk_permission_mode(&self, project_id: Option<&str>) -> String {
        let settings = self.get();
        let raw = project_id
            .and_then(|id| settings.project_overrides.get(id))
            .and_then(|ov| ov.permission_mode.clone())
            .unwrap_or(settings.permission_mode);
        sdk_permission_mode(&raw)
    }

    /// Apply a patch, persist, and return the merged settings.
    fn update(&self, patch: SettingsPatch) -> Result<Settings, String> {
        let mut guard = self.settings.lock().expect("settings store poisoned");
        guard.merge(patch);
        let snapshot = guard.clone();
        write_settings(&self.config_dir.join("settings.json"), &snapshot)?;
        Ok(snapshot)
    }
}

/// Map a Nightcore permission-mode setting to the engine's SDK `permissionMode`.
/// Fail-closed: anything unrecognized maps to `default` (the engine then prompts),
/// never to an auto-allowing mode.
pub fn sdk_permission_mode(raw: &str) -> String {
    match raw {
        "auto-accept" => "acceptEdits",
        "plan" => "plan",
        "ask" => "default",
        _ => "default",
    }
    .to_string()
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

// --- Commands ---------------------------------------------------------------

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
        assert_eq!(s.default_model, "opus-4.8");
        assert_eq!(s.max_concurrency, 3);
        assert_eq!(s.permission_mode, "auto-accept");
        assert_eq!(s.theme, "cosmic");
        assert!(s.cleanup_worktrees);
        assert!(!s.notify_on_complete);
        assert!(s.project_overrides.is_empty());
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
        assert_eq!(merged.permission_mode, "auto-accept");

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
        assert_eq!(merged.default_model, "opus-4.8");
        let ov = merged.project_overrides.get("proj-1").expect("override exists");
        assert_eq!(ov.default_model.as_deref(), Some("haiku-4.5"));
        assert!(ov.default_effort.is_none(), "only the patched field is set");
    }

    #[test]
    fn maps_permission_modes_to_sdk_and_fails_closed() {
        assert_eq!(sdk_permission_mode("auto-accept"), "acceptEdits");
        assert_eq!(sdk_permission_mode("plan"), "plan");
        assert_eq!(sdk_permission_mode("ask"), "default");
        // Fail-closed: anything unrecognized prompts, never bypasses.
        assert_eq!(sdk_permission_mode("garbage"), "default");
        assert_eq!(sdk_permission_mode("bypassPermissions"), "default");
    }

    #[test]
    fn sdk_permission_mode_prefers_project_override() {
        let (store, _tmp) = temp_store();
        // Global default is auto-accept → acceptEdits.
        assert_eq!(store.sdk_permission_mode(None), "acceptEdits");

        // A per-project override to `plan` wins for that project only.
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"projectId":"p1","permissionMode":"plan"}"#).unwrap();
        store.update(patch).expect("update");
        assert_eq!(store.sdk_permission_mode(Some("p1")), "plan");
        assert_eq!(store.sdk_permission_mode(Some("other")), "acceptEdits");
        assert_eq!(store.sdk_permission_mode(None), "acceptEdits");
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
            "projectOverrides",
        ] {
            assert!(obj.contains_key(key), "missing camelCase key {key}");
        }
    }
}
