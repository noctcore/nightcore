//! The `Settings` / `McpServerEntry` / `McpServerTransport` data types and their
//! wire-twin conversions into the `contracts` types.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
// `ts-rs` is a dev-dependency; the codegen derive + the `RunMode` narrowing it
// references are gated to `cfg(test)`.
#[cfg(test)]
use crate::task::RunMode;
#[cfg(test)]
use ts_rs::TS;

use super::patch::SettingsOverride;

/// Global settings + per-project overrides. Field names mirror the Phase 2
/// contract and serialize camelCase for the TS bridge and on-disk JSON.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "Settings.ts"))]
pub struct Settings {
    pub default_model: String,
    pub default_effort: String,
    /// 1..=6. The auto-loop enforces it as the slot-pool cap; a global change
    /// resizes the live pool to match.
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
