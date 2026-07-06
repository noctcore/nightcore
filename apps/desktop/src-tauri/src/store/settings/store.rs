//! The managed [`SettingsStore`]: load/save + per-project resolution accessors,
//! plus the `AppInfo` metadata type. The settings command handlers the webview
//! calls now live in `commands/settings.rs` (they up-call orchestration, so they
//! sit above this persistence leaf).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
#[cfg(test)]
use ts_rs::TS;

use super::helpers::*;
use super::model::{BoardBackgroundRef, McpServerEntry, Settings};
use super::patch::SettingsPatch;

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

    /// A snapshot of the current settings. Deep-clones the whole `Settings`
    /// (including `mcp_servers` + every `project_overrides` block) — reserve it for
    /// the `read_settings` command, which genuinely returns the full struct to the
    /// webview. Single-field reads should go through [`with_settings`](Self::with_settings).
    pub fn get(&self) -> Settings {
        crate::sync::lock_or_recover(&self.settings).clone()
    }

    /// Run `f` against the live settings under the lock and return its result,
    /// WITHOUT cloning the whole `Settings`. Every single-field resolver below reads
    /// through this, so a per-task create (which resolves five defaults) or a
    /// terminal event (which reads one bool) no longer deep-clones `mcp_servers` and
    /// the `project_overrides` map just to extract one scalar. `f` runs while the
    /// lock is held, so keep it to cheap field reads (the resolvers only borrow a
    /// field and, at most, clone that single value).
    pub fn with_settings<R>(&self, f: impl FnOnce(&Settings) -> R) -> R {
        f(&crate::sync::lock_or_recover(&self.settings))
    }

    /// The effective autonomy ceiling for a project (its override, else the global),
    /// parsed to the neutral wire [`AutonomyLevel`] (see [`parse_autonomy`]). The
    /// Claude provider lowers it to an SDK permission mode at its own boundary.
    pub fn autonomy(&self, project_id: Option<&str>) -> crate::contracts::AutonomyLevel {
        self.with_settings(|settings| {
            let raw = project_id
                .and_then(|id| settings.project_overrides.get(id))
                .and_then(|ov| ov.permission_mode.as_deref())
                .unwrap_or(&settings.permission_mode);
            parse_autonomy(raw)
        })
    }

    /// The effective default run mode for a project (its override, else the
    /// global), parsed to a [`RunMode`]. Fail-safe: an unrecognized value resolves
    /// to `Main` (worktrees are opt-in, never silently auto-isolated).
    pub fn default_run_mode(&self, project_id: Option<&str>) -> crate::task::RunMode {
        self.with_settings(|settings| {
            let raw = project_id
                .and_then(|id| settings.project_overrides.get(id))
                .and_then(|ov| ov.default_run_mode.as_deref())
                .unwrap_or(&settings.default_run_mode);
            parse_run_mode(raw)
        })
    }

    /// The effective default model for a project (its override, else the global),
    /// canonicalized to an SDK long id (see [`canonical_model_id`]). This is the
    /// value `create_task` stamps onto a task whose create call omits a model, so
    /// the Settings default is what a new task actually runs with (P0).
    pub fn default_model(&self, project_id: Option<&str>) -> String {
        self.with_settings(|settings| {
            let raw = project_id
                .and_then(|id| settings.project_overrides.get(id))
                .and_then(|ov| ov.default_model.as_deref())
                .unwrap_or(&settings.default_model);
            canonical_model_id(raw)
        })
    }

    /// The effective default reasoning effort for a project (its override, else the
    /// global). Effort values already match the SDK levels, so no mapping is needed.
    pub fn default_effort(&self, project_id: Option<&str>) -> String {
        self.with_settings(|settings| {
            project_id
                .and_then(|id| settings.project_overrides.get(id))
                .and_then(|ov| ov.default_effort.as_deref())
                .unwrap_or(&settings.default_effort)
                .to_string()
        })
    }

    /// The effective default max-turns ceiling for a project (its override, else
    /// the global). `None` ⇒ no Settings ceiling, so `create_task` leaves the
    /// task's `max_turns` as `None` and the engine's `@nightcore/config` default
    /// (200) applies. Mirrors [`default_model`](Self::default_model)'s
    /// project-override → global resolution.
    pub fn default_max_turns(&self, project_id: Option<&str>) -> Option<u32> {
        self.with_settings(|settings| {
            project_id
                .and_then(|id| settings.project_overrides.get(id))
                .and_then(|ov| ov.max_turns)
                .or(settings.max_turns)
        })
    }

    /// The effective default max-budget-USD ceiling for a project (its override,
    /// else the global). `None` ⇒ uncapped at the Settings level; the engine's
    /// config default applies. Mirrors [`default_max_turns`](Self::default_max_turns).
    pub fn default_max_budget_usd(&self, project_id: Option<&str>) -> Option<f64> {
        self.with_settings(|settings| {
            project_id
                .and_then(|id| settings.project_overrides.get(id))
                .and_then(|ov| ov.max_budget_usd)
                .or(settings.max_budget_usd)
        })
    }

    /// The effective enabled MCP server list for a project, ready to inject on
    /// `start-session`. Resolution mirrors [`default_model`](Self::default_model):
    /// a project override REPLACES the global list wholesale (`Some(list)` wins),
    /// else the global list applies; then only `enabled` entries are returned (the
    /// per-entry toggle gates injection). An empty result ⇒ inject nothing (the
    /// pre-feature shape).
    ///
    /// Whole-list-replace, NOT a cross-scope merge — a project that sets its own
    /// list owns it entirely, the same semantics every other overridable setting
    /// uses here (no field/entry-level merge model is introduced).
    pub fn enabled_mcp_servers(&self, project_id: Option<&str>) -> Vec<McpServerEntry> {
        self.with_settings(|settings| {
            let resolved = project_id
                .and_then(|id| settings.project_overrides.get(id))
                .and_then(|ov| ov.mcp_servers.as_ref())
                .unwrap_or(&settings.mcp_servers);
            // Clone only the enabled entries we return, not the whole Settings.
            resolved.iter().filter(|s| s.enabled).cloned().collect()
        })
    }

    /// Whether the Pre-flight Context Pack (Lock, feature #4) is injected for a
    /// project: its override, else the global toggle. The coordinator gates reading
    /// `.nightcore/context.md` on this — a project with the toggle off runs exactly
    /// like pre-feature (no pack injected, even if a `context.md` exists). Mirrors
    /// [`default_model`](Self::default_model)'s project-override → global resolution.
    pub fn context_pack_enabled(&self, project_id: Option<&str>) -> bool {
        self.with_settings(|settings| {
            project_id
                .and_then(|id| settings.project_overrides.get(id))
                .and_then(|ov| ov.context_pack_enabled)
                .unwrap_or(settings.context_pack_enabled)
        })
    }

    /// Apply a patch, persist, and return the merged settings.
    pub(crate) fn update(&self, patch: SettingsPatch) -> Result<Settings, String> {
        let mut guard = crate::sync::lock_or_recover(&self.settings);
        guard.merge(patch);
        let snapshot = guard.clone();
        write_settings(&self.config_dir.join("settings.json"), &snapshot)?;
        Ok(snapshot)
    }

    /// The project's stored board-background ref (Custom Background), if any. Read
    /// by the `read_board_background` command to locate the on-disk bytes and by
    /// cleanup to know a project had a background. Board appearance is per-project
    /// only, so there is no global fallback — an absent override ⇒ `None`.
    pub fn board_background(&self, project_id: &str) -> Option<BoardBackgroundRef> {
        self.with_settings(|settings| {
            settings
                .project_overrides
                .get(project_id)
                .and_then(|ov| ov.board_background.clone())
        })
    }

    /// Set (or replace) a project's board-background ref, bumping its `version` so
    /// the web re-reads the bytes even when a replacement keeps the same `format`.
    /// Persists and returns the merged settings. The bytes themselves are written to
    /// disk by [`crate::store::board_background::persist`] BEFORE this call; this only
    /// records the reference. (Custom Background — the image ref lives in the
    /// per-project override, never in the global block.)
    pub(crate) fn set_board_background(
        &self,
        project_id: &str,
        format: String,
    ) -> Result<Settings, String> {
        let mut guard = crate::sync::lock_or_recover(&self.settings);
        let entry = guard
            .project_overrides
            .entry(project_id.to_string())
            .or_default();
        // Monotonic replace counter: previous + 1 (first set ⇒ 1) so a same-format
        // replacement still changes the ref, letting the web cache-bust its image.
        let next_version = entry
            .board_background
            .as_ref()
            .map(|b| b.version.saturating_add(1))
            .unwrap_or(1);
        entry.board_background = Some(BoardBackgroundRef {
            format,
            version: next_version,
        });
        let snapshot = guard.clone();
        write_settings(&self.config_dir.join("settings.json"), &snapshot)?;
        Ok(snapshot)
    }

    /// Clear a project's board-background ref and persist, pruning the override block
    /// if it becomes empty (mirrors [`drop_project_override`](Self::drop_project_override)'s
    /// no-orphan discipline). A no-op when the project has no background. The on-disk
    /// bytes are removed by the `clear_board_background` command separately.
    pub(crate) fn clear_board_background(&self, project_id: &str) -> Result<Settings, String> {
        let mut guard = crate::sync::lock_or_recover(&self.settings);
        if let Some(entry) = guard.project_overrides.get_mut(project_id) {
            if entry.board_background.is_none() {
                return Ok(guard.clone()); // nothing to clear
            }
            entry.board_background = None;
            if entry.is_empty() {
                guard.project_overrides.remove(project_id);
            }
        }
        let snapshot = guard.clone();
        write_settings(&self.config_dir.join("settings.json"), &snapshot)?;
        Ok(snapshot)
    }

    /// Drop a project's override block and persist (data-integrity #4). Called when
    /// a project is deleted so its `project_overrides[id]` entry can't orphan in the
    /// settings file (and silently shape a future project that reuses the id). A
    /// no-op when no override exists for the id.
    pub fn drop_project_override(&self, project_id: &str) -> Result<(), String> {
        let mut guard = crate::sync::lock_or_recover(&self.settings);
        if guard.project_overrides.remove(project_id).is_none() {
            return Ok(()); // nothing to drop
        }
        let snapshot = guard.clone();
        write_settings(&self.config_dir.join("settings.json"), &snapshot)
    }

    /// Test-only seam: apply a patch to an in-memory store (used by other modules'
    /// tests — e.g. `task::build_new_task` — to set up Settings defaults without
    /// reaching into the private [`update`](Self::update)).
    #[cfg(test)]
    pub(crate) fn update_for_test(&self, patch: SettingsPatch) -> Result<Settings, String> {
        self.update(patch)
    }
}

/// Read-only application metadata for the About page. Sourced from build-time
/// constants (Cargo package version + a compiled-in repo URL) so the UI shows
/// real values instead of hardcoded literals.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "AppInfo.ts"))]
pub struct AppInfo {
    /// The app version (the `[package] version` in `Cargo.toml`).
    pub version: String,
    /// The canonical source repository URL.
    pub repository: String,
}

/// The repository URL, compiled in (no fake `github.com/you` literal in the UI).
pub(crate) const REPOSITORY_URL: &str = "https://github.com/Shironex/nightcore";
