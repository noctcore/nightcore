//! Global + per-project settings (Phase 2).
//!
//! Settings live in Tauri's **app config dir** as `settings.json`: global defaults
//! plus a `projectOverrides` map keyed by project id. A patch with no `projectId`
//! shallow-merges into the global block; with a `projectId` it merges into that
//! project's override. The run-shaping fields are now enforced (the M2 auto-loop
//! honors `maxConcurrency`/`cleanupWorktrees`, runs apply the guardrails); only the
//! M3 `notifyOnComplete` toggle still persists without a consumer — the UI keeps it
//! visible and roadmap-badged.
//!
//! Held in managed Tauri state; commands take it as `State<'_, SettingsStore>`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
// `ts-rs` is a dev-dependency; the codegen derive + the `RunMode` narrowing it
// references are gated to `cfg(test)`.
#[cfg(test)]
use crate::task::RunMode;
#[cfg(test)]
use ts_rs::TS;

/// Global settings + per-project overrides. Field names mirror the Phase 2
/// contract and serialize camelCase for the TS bridge and on-disk JSON.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "Settings.ts"))]
pub struct Settings {
    pub default_model: String,
    pub default_effort: String,
    /// 1..=6. The M2 auto-loop enforces it as the slot-pool cap (a global change
    /// resizes the live pool via [`crate::m2::coordinator::set_max_concurrency`]).
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
    // Stored as a free string (fail-safe: an unknown value resolves to Main), but
    // the wire values are exactly the [`RunMode`] vocabulary — narrow the generated
    // TS to `RunMode` so the Settings form's run-mode control type-checks.
    #[serde(default = "default_run_mode_value")]
    #[cfg_attr(test, ts(as = "RunMode"))]
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
    /// User-configured external MCP servers the Rust core injects (enabled entries
    /// only) on each `start-session`. Per-project overridable (whole-list replace —
    /// see [`SettingsOverride::mcp_servers`]). Serde-additive: a settings file
    /// written before this field loads as `[]`. Values in `env`/`headers` may carry
    /// secrets; persisted plaintext, same trust model as the user's `~/.claude.json`.
    #[serde(default)]
    pub mcp_servers: Vec<McpServerEntry>,
    /// Pre-flight Context Pack (Lock, feature #4): whether the Nightcore-curated
    /// project Constitution (`.nightcore/context.md`) is injected into agent runs'
    /// `appendSystemPrompt`. Per-project overridable. Default `true` (a project that
    /// has authored a context pack gets it on-rails; the toggle opts a project OUT).
    /// Serde-additive: a settings file written before this field loads as `true`.
    #[serde(default = "default_true")]
    pub context_pack_enabled: bool,
    /// Per-project overrides keyed by project id.
    pub project_overrides: HashMap<String, SettingsOverride>,
}

/// One user-configured external MCP server. Serde-additive; ts-rs exports it for
/// the Settings MCP form. Serializes to the SAME camelCase wire shape as the
/// contract [`crate::contracts::McpServerEntry`] (the round-trip the two-aligned-
/// structs pattern guarantees — like `Settings` itself), so the resolved list can
/// be handed straight to the `start-session` command.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "McpServerEntry.ts"))]
pub struct McpServerEntry {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub config: McpServerTransport,
}

/// Transport-tagged MCP server config (serde internally-tagged by `transport`, to
/// match the contract union and avoid colliding with the SDK's optional stdio
/// `type`). `env`/`headers` are string→string maps; the engine translates this to
/// the SDK `Options.mcpServers` shape (omitting `type` for stdio, setting it for
/// http/sse).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(tag = "transport", rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "McpServerTransport.ts"))]
pub enum McpServerTransport {
    #[serde(rename_all = "camelCase")]
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
    },
    #[serde(rename_all = "camelCase")]
    Http {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
    #[serde(rename_all = "camelCase")]
    Sse {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
}

/// The serde default for `default_run_mode` (a legacy settings file without the
/// field loads as `"main"`).
fn default_run_mode_value() -> String {
    "main".to_string()
}

/// The serde default for `context_pack_enabled` (a legacy settings file without the
/// field loads as `true` — a project's authored Constitution is injected by default).
fn default_true() -> bool {
    true
}

/// Convert a `HashMap<String, String>` into the contract transport's JSON map shape
/// (`serde_json::Map<String, serde_json::Value>`). The store keeps env/header values
/// as plain strings; the codegen-emitted contract type uses an opaque JSON object.
/// Both serialize to the same `{ "k": "v" }` wire shape, so this is a lossless lift.
fn string_map_to_json(map: HashMap<String, String>) -> serde_json::Map<String, serde_json::Value> {
    map.into_iter()
        .map(|(k, v)| (k, serde_json::Value::String(v)))
        .collect()
}

/// Lift a store [`McpServerTransport`] into its wire-identical contract twin. The
/// two structs describe the same JSON (the two-aligned-structs pattern); this is the
/// single mapping point so the resolved store list can travel on the typed
/// `start-session` command.
impl From<McpServerTransport> for crate::contracts::McpServerTransport {
    fn from(t: McpServerTransport) -> Self {
        match t {
            McpServerTransport::Stdio { command, args, env } => {
                crate::contracts::McpServerTransport::Stdio {
                    command,
                    args,
                    env: string_map_to_json(env),
                }
            }
            McpServerTransport::Http { url, headers } => {
                crate::contracts::McpServerTransport::Http {
                    url,
                    headers: string_map_to_json(headers),
                }
            }
            McpServerTransport::Sse { url, headers } => crate::contracts::McpServerTransport::Sse {
                url,
                headers: string_map_to_json(headers),
            },
        }
    }
}

/// Lift a store [`McpServerEntry`] into the contract twin carried on `start-session`.
impl From<McpServerEntry> for crate::contracts::McpServerEntry {
    fn from(e: McpServerEntry) -> Self {
        crate::contracts::McpServerEntry {
            id: e.id,
            name: e.name,
            enabled: e.enabled,
            config: e.config.into(),
        }
    }
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
            // No MCP servers configured by default — a new task injects none until
            // the user adds one in the Settings MCP form.
            mcp_servers: Vec::new(),
            // Lock (feature #4): the curated Constitution is injected by default; a
            // project with no `context.md` simply has nothing to inject (a no-op).
            context_pack_enabled: true,
            project_overrides: HashMap::new(),
        }
    }
}

/// A per-project override: any subset of the run-shaping fields. Absent fields
/// fall back to the global value.
// A per-project override carries only the keys the project set, so every field is
// an OPTIONAL TS key (`field?: T`), matching the prior hand-mirror (none nullable).
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "SettingsOverride.ts"))]
pub struct SettingsOverride {
    #[cfg_attr(test, ts(optional))]
    pub default_model: Option<String>,
    #[cfg_attr(test, ts(optional))]
    pub default_effort: Option<String>,
    #[cfg_attr(test, ts(optional))]
    pub max_concurrency: Option<u8>,
    #[cfg_attr(test, ts(optional))]
    pub permission_mode: Option<String>,
    /// M4.6: per-project default run mode (`"main"` | `"worktree"`).
    #[cfg_attr(test, ts(optional, as = "Option<RunMode>"))]
    pub default_run_mode: Option<String>,
    /// SDK-guardrails: per-project default max-turns ceiling (overrides the global
    /// `max_turns` for this project's new tasks).
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub max_turns: Option<u32>,
    /// SDK-guardrails: per-project default max-budget-USD ceiling.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub max_budget_usd: Option<f64>,
    /// Per-project MCP server list. `None` ⇒ inherit the global list; `Some(list)`
    /// ⇒ REPLACE it wholesale for this project (the same override-wins-else-global
    /// resolution every other field uses — `default_model` is the template; no
    /// cross-scope merge). Serde-additive: a legacy override block loads this `None`.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub mcp_servers: Option<Vec<McpServerEntry>>,
    /// Lock (feature #4): per-project override of whether the context pack is
    /// injected. `None` ⇒ inherit the global toggle. Serde-additive.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub context_pack_enabled: Option<bool>,
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
        // Whole-list replace: the UI sends the project's full next list (or `None`
        // to clear the override back to inheriting the global list).
        if patch.mcp_servers.is_some() {
            self.mcp_servers = patch.mcp_servers.clone();
        }
        if patch.context_pack_enabled.is_some() {
            self.context_pack_enabled = patch.context_pack_enabled;
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
            && self.mcp_servers.is_none()
            && self.context_pack_enabled.is_none()
    }
}

/// A partial update. A `projectId` targets a per-project override; otherwise the
/// patch merges into the global block. Every field optional.
// The web sends only the keys it changed, so every field is an OPTIONAL TS key
// (`field?: T`), matching the prior hand-mirror (none nullable). Deserialize-only;
// ts-rs derives `TS` without a `Serialize` impl.
#[derive(Debug, Default, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "SettingsPatch.ts"))]
pub struct SettingsPatch {
    #[cfg_attr(test, ts(optional))]
    pub project_id: Option<String>,
    #[cfg_attr(test, ts(optional))]
    pub default_model: Option<String>,
    #[cfg_attr(test, ts(optional))]
    pub default_effort: Option<String>,
    #[cfg_attr(test, ts(optional))]
    pub max_concurrency: Option<u8>,
    #[cfg_attr(test, ts(optional))]
    pub permission_mode: Option<String>,
    #[cfg_attr(test, ts(optional))]
    pub cleanup_worktrees: Option<bool>,
    #[cfg_attr(test, ts(optional))]
    pub notify_on_complete: Option<bool>,
    /// M4.6: default run mode (`"main"` | `"worktree"`). With a `projectId` it lands
    /// in that project's override; without one, the global default.
    #[cfg_attr(test, ts(optional, as = "Option<RunMode>"))]
    pub default_run_mode: Option<String>,
    /// SDK-guardrails: default max-turns ceiling. With a `projectId` it lands in
    /// that project's override; without one, the global default.
    #[cfg_attr(test, ts(optional))]
    pub max_turns: Option<u32>,
    /// SDK-guardrails: default max-budget-USD ceiling. With a `projectId` it lands
    /// in that project's override; without one, the global default.
    #[cfg_attr(test, ts(optional))]
    pub max_budget_usd: Option<f64>,
    /// The full next external MCP server list (whole-list replace). With a
    /// `projectId` it sets that project's override list; without one, the global
    /// list. The UI always sends the COMPLETE next list (add/edit/remove/toggle all
    /// resolve to "here is the new list"), so there is no partial-entry merge.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub mcp_servers: Option<Vec<McpServerEntry>>,
    /// Lock (feature #4): toggle context-pack injection. With a `projectId` it lands
    /// in that project's override; without one, the global default.
    #[cfg_attr(test, ts(optional))]
    pub context_pack_enabled: Option<bool>,
}

impl Settings {
    /// Shallow-merge `patch`. With a `projectId`, the run-shaping fields land in
    /// that project's override (global-only fields like `cleanup_worktrees` /
    /// `notify_on_complete` are ignored for an override target); without one, they
    /// merge into the global block.
    fn merge(&mut self, patch: SettingsPatch) {
        if let Some(project_id) = patch.project_id.clone() {
            let entry = self
                .project_overrides
                .entry(project_id.clone())
                .or_default();
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
        // MCP servers: a present value REPLACES the global list with the UI's full
        // next list. Unlike the `Option` ceilings, the empty list is a meaningful
        // value (clear all servers) — `Some([])` sets an empty global list. Serde
        // collapses absent and explicit-null to `None`, so a patch that omits the
        // key leaves the list untouched.
        if let Some(servers) = patch.mcp_servers {
            self.mcp_servers = servers;
        }
        // Lock (feature #4): a present value sets the global toggle. Like the other
        // booleans, serde maps absent/null to `None`, so an omitted key is a no-op.
        if let Some(v) = patch.context_pack_enabled {
            self.context_pack_enabled = v;
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
        crate::sync::lock_or_recover(&self.settings).clone()
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
        let settings = self.get();
        let resolved = project_id
            .and_then(|id| settings.project_overrides.get(id))
            .and_then(|ov| ov.mcp_servers.clone())
            .unwrap_or(settings.mcp_servers);
        resolved.into_iter().filter(|s| s.enabled).collect()
    }

    /// Whether the Pre-flight Context Pack (Lock, feature #4) is injected for a
    /// project: its override, else the global toggle. The coordinator gates reading
    /// `.nightcore/context.md` on this — a project with the toggle off runs exactly
    /// like pre-feature (no pack injected, even if a `context.md` exists). Mirrors
    /// [`default_model`](Self::default_model)'s project-override → global resolution.
    pub fn context_pack_enabled(&self, project_id: Option<&str>) -> bool {
        let settings = self.get();
        project_id
            .and_then(|id| settings.project_overrides.get(id))
            .and_then(|ov| ov.context_pack_enabled)
            .unwrap_or(settings.context_pack_enabled)
    }

    /// Apply a patch, persist, and return the merged settings.
    fn update(&self, patch: SettingsPatch) -> Result<Settings, String> {
        let mut guard = crate::sync::lock_or_recover(&self.settings);
        guard.merge(patch);
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
    // Atomic temp-file + rename (data-integrity #3): a crash/concurrent reader never
    // sees a half-written settings file.
    crate::store::write_atomic(path, json.as_bytes())
        .map_err(|e| format!("failed to write {}: {e}", path.display()))?;
    // settings.json holds plaintext MCP `env`/`headers` secrets, so restrict it to
    // the owner (0600) — the default umask can otherwise leave it group/world
    // readable. No-op on Windows (no Unix permission bits).
    restrict_to_owner(path)
}

/// Set `path` to owner-only (mode 0600) on Unix so its plaintext secrets aren't
/// readable by other users on the machine. A no-op on non-Unix targets.
#[cfg(unix)]
fn restrict_to_owner(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("failed to restrict {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) -> Result<(), String> {
    Ok(())
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
    let resize = patch
        .project_id
        .is_none()
        .then_some(patch.max_concurrency)
        .flatten();
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

    #[cfg(unix)]
    #[test]
    fn settings_file_is_written_owner_only_0600() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().expect("temp dir");
        let path = tmp.path().join("settings.json");
        write_settings(&path, &Settings::default()).expect("write");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        // settings.json holds plaintext MCP secrets — only the owner may read it.
        assert_eq!(
            mode & 0o777,
            0o600,
            "settings.json must be owner-only (0600), got {:o}",
            mode & 0o777
        );
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
        let ov = merged
            .project_overrides
            .get("proj-1")
            .expect("override exists");
        assert_eq!(ov.default_model.as_deref(), Some("haiku-4.5"));
        assert!(ov.default_effort.is_none(), "only the patched field is set");
    }

    #[test]
    fn drop_project_override_removes_it_and_persists() {
        // data-integrity #4: deleting a project drops its override so it can't orphan.
        let (store, tmp) = temp_store();
        store
            .update(
                serde_json::from_str(r#"{"projectId":"p1","defaultModel":"claude-sonnet-4-6"}"#)
                    .unwrap(),
            )
            .expect("seed override");
        assert!(store.get().project_overrides.contains_key("p1"));

        store.drop_project_override("p1").expect("drop");
        assert!(
            !store.get().project_overrides.contains_key("p1"),
            "override is gone from memory"
        );
        // Persisted: a reload no longer carries the orphaned override.
        let reloaded = SettingsStore::load_from(tmp.path().join("config"));
        assert!(!reloaded.get().project_overrides.contains_key("p1"));

        // Dropping a non-existent override is a no-op (no error).
        store.drop_project_override("ghost").expect("no-op drop");
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
        assert_eq!(
            store.sdk_permission_mode(Some("other")),
            "bypassPermissions"
        );
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
            .update(serde_json::from_str(r#"{"projectId":"p1","defaultRunMode":"main"}"#).unwrap())
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
            "mcpServers",
            "contextPackEnabled",
            "projectOverrides",
        ] {
            assert!(obj.contains_key(key), "missing camelCase key {key}");
        }
    }

    #[test]
    fn context_pack_enabled_defaults_true_and_is_serde_additive() {
        // Lock (feature #4): the curated Constitution is injected by default.
        assert!(Settings::default().context_pack_enabled);

        // A settings.json from before the Context Pack UI (no `contextPackEnabled`)
        // still parses, defaulting the field to `true` — existing config isn't broken.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"claude-opus-4-8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","cleanupWorktrees":true,
            "notifyOnComplete":false,"defaultRunMode":"main","projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();
        let store = SettingsStore::load_from(dir);
        assert!(store.get().context_pack_enabled);
        assert!(store.context_pack_enabled(None));
    }

    #[test]
    fn context_pack_enabled_resolves_project_then_global() {
        let (store, _tmp) = temp_store();
        // Global default is on for every project without an own override.
        assert!(store.context_pack_enabled(None));
        assert!(store.context_pack_enabled(Some("any")));

        // A per-project override OFF wins for that project only — how a project opts
        // out of the on-rails Constitution.
        store
            .update(
                serde_json::from_str(r#"{"projectId":"p1","contextPackEnabled":false}"#).unwrap(),
            )
            .expect("update");
        assert!(!store.context_pack_enabled(Some("p1")));
        assert!(store.context_pack_enabled(Some("other")));
        assert!(store.context_pack_enabled(None));

        // The override is project-scoped, not global.
        let merged = store.get();
        assert!(merged.context_pack_enabled, "global stays on");
        assert_eq!(
            merged.project_overrides.get("p1").unwrap().context_pack_enabled,
            Some(false)
        );

        // A global toggle OFF flips it for projects without an own override.
        store
            .update(serde_json::from_str(r#"{"contextPackEnabled":false}"#).unwrap())
            .expect("global update");
        assert!(!store.context_pack_enabled(None));
        assert!(!store.context_pack_enabled(Some("other")));
        // The project override still wins (it is explicitly false too here).
        assert!(!store.context_pack_enabled(Some("p1")));
    }

    /// A stdio server entry fixture for the MCP tests.
    fn stdio_entry(id: &str, name: &str, enabled: bool) -> McpServerEntry {
        McpServerEntry {
            id: id.to_string(),
            name: name.to_string(),
            enabled,
            config: McpServerTransport::Stdio {
                command: "npx".to_string(),
                args: vec!["-y".to_string(), "pkg".to_string()],
                env: HashMap::new(),
            },
        }
    }

    #[test]
    fn mcp_servers_default_to_empty_and_are_serde_additive() {
        // A fresh Settings has no MCP servers; the resolver returns an empty list.
        let s = Settings::default();
        assert!(s.mcp_servers.is_empty());

        // A settings.json from before the MCP UI (no `mcpServers`) still parses,
        // defaulting the field to `[]` — existing config files aren't broken.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"claude-opus-4-8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","cleanupWorktrees":true,
            "notifyOnComplete":false,"defaultRunMode":"main","projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();
        let store = SettingsStore::load_from(dir);
        assert!(store.get().mcp_servers.is_empty());
        assert!(store.enabled_mcp_servers(None).is_empty());
    }

    #[test]
    fn mcp_servers_round_trip_persist_and_reload() {
        let (store, tmp) = temp_store();
        let patch: SettingsPatch = serde_json::from_str(
            r#"{"mcpServers":[
                {"id":"s1","name":"filesystem","enabled":true,
                 "config":{"transport":"stdio","command":"npx","args":["-y","pkg"],"env":{"ROOT":"/x"}}},
                {"id":"s2","name":"github","enabled":false,
                 "config":{"transport":"http","url":"https://x/mcp","headers":{"Authorization":"Bearer t"}}}
            ]}"#,
        )
        .unwrap();
        let merged = store.update(patch).expect("update");
        assert_eq!(merged.mcp_servers.len(), 2);

        // Persisted: a fresh store reloads the exact list (including the http entry's
        // headers and the disabled flag).
        let reloaded = SettingsStore::load_from(tmp.path().join("config"));
        let servers = reloaded.get().mcp_servers;
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].name, "filesystem");
        assert!(matches!(
            &servers[1].config,
            McpServerTransport::Http { url, headers }
                if url == "https://x/mcp" && headers.get("Authorization").is_some()
        ));
    }

    #[test]
    fn enabled_mcp_servers_filters_disabled_entries() {
        let (store, _tmp) = temp_store();
        store
            .update(SettingsPatch {
                mcp_servers: Some(vec![
                    stdio_entry("a", "alpha", true),
                    stdio_entry("b", "bravo", false),
                    stdio_entry("c", "charlie", true),
                ]),
                ..Default::default()
            })
            .expect("update");

        let enabled = store.enabled_mcp_servers(None);
        let names: Vec<&str> = enabled.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["alpha", "charlie"],
            "only enabled entries inject"
        );
    }

    #[test]
    fn enabled_mcp_servers_resolves_project_override_then_global() {
        let (store, _tmp) = temp_store();
        // Global list: one enabled server.
        store
            .update(SettingsPatch {
                mcp_servers: Some(vec![stdio_entry("g", "global-srv", true)]),
                ..Default::default()
            })
            .expect("global update");
        // Every project without an own list sees the global one.
        assert_eq!(
            store
                .enabled_mcp_servers(Some("other"))
                .iter()
                .map(|s| s.name.clone())
                .collect::<Vec<_>>(),
            vec!["global-srv".to_string()]
        );

        // A project override REPLACES the global list wholesale for that project.
        store
            .update(SettingsPatch {
                project_id: Some("p1".to_string()),
                mcp_servers: Some(vec![stdio_entry("p", "project-srv", true)]),
                ..Default::default()
            })
            .expect("project update");
        assert_eq!(
            store
                .enabled_mcp_servers(Some("p1"))
                .iter()
                .map(|s| s.name.clone())
                .collect::<Vec<_>>(),
            vec!["project-srv".to_string()],
            "the project override wins and replaces the global list"
        );
        // The global list and other projects are untouched.
        assert_eq!(
            store.enabled_mcp_servers(None),
            vec![stdio_entry("g", "global-srv", true)]
        );
    }

    #[test]
    fn mcp_servers_project_patch_writes_an_override_not_the_global() {
        let (store, _tmp) = temp_store();
        let merged = store
            .update(SettingsPatch {
                project_id: Some("proj-1".to_string()),
                mcp_servers: Some(vec![stdio_entry("x", "x", true)]),
                ..Default::default()
            })
            .expect("update");

        // The global list is untouched; the override carries the project's list.
        assert!(merged.mcp_servers.is_empty(), "global list stays empty");
        let ov = merged
            .project_overrides
            .get("proj-1")
            .expect("override exists");
        assert_eq!(ov.mcp_servers.as_ref().map(|l| l.len()), Some(1));

        // The UI clears a project's list by sending an explicit EMPTY list
        // (`Some([])`), which replaces it — not by omitting the key. (An omitted
        // `mcpServers` is a no-op, like the `Option` ceilings: serde maps absent and
        // null to `None`, so the override list can only be SET/replaced, never
        // implicitly cleared.) `Some([])` here leaves an empty override list, so the
        // override block survives (it carries an intentional empty list).
        store
            .update(SettingsPatch {
                project_id: Some("proj-1".to_string()),
                mcp_servers: Some(vec![]),
                ..Default::default()
            })
            .expect("clear to empty");
        let ov = store.get();
        let ov = ov.project_overrides.get("proj-1").expect("override exists");
        assert_eq!(
            ov.mcp_servers.as_ref().map(|l| l.len()),
            Some(0),
            "an explicit empty list replaces the override list"
        );
        // And that project now injects nothing (resolves to the empty override list,
        // NOT back to the global list).
        assert!(store.enabled_mcp_servers(Some("proj-1")).is_empty());
    }

    #[test]
    fn guardrail_defaults_are_none_and_serde_additive() {
        // SDK-guardrails: with no Settings knob set, the resolvers return None so a
        // new task inherits the engine's `@nightcore/config` default.
        let s = Settings::default();
        assert!(
            s.max_turns.is_none(),
            "max_turns defaults to None (inherit)"
        );
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
            .update(serde_json::from_str(r#"{"maxTurns":150,"maxBudgetUsd":5.0}"#).unwrap())
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
        let ov = merged
            .project_overrides
            .get("proj-1")
            .expect("override exists");
        assert_eq!(ov.max_turns, Some(42));
        assert!(ov.max_budget_usd.is_none(), "only the patched field is set");
    }
}
