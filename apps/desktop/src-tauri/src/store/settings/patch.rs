//! Per-project overrides ([`SettingsOverride`]), the partial-update wire type
//! ([`SettingsPatch`]), and the merge/apply logic that folds a patch into the
//! global block or a project's override.

use serde::{Deserialize, Serialize};

#[cfg(test)]
use crate::task::RunMode;
#[cfg(test)]
use ts_rs::TS;

use super::model::{McpServerEntry, Settings};

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
    pub(super) fn merge(&mut self, patch: SettingsPatch) {
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
