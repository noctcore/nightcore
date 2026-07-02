//! The read-only provider-configuration inspector command.
//!
//! Surfaces how the active provider (today: Claude) is RESOLVED for the active
//! project — its MCP servers, skills, subagents, and scalar extras (model /
//! permission mode / output style) — over the request/reply NDJSON path. The
//! command issues a `get-provider-config` [`SurfaceQuery`] through
//! [`crate::sidecar::query`], so a future provider that declines a section returns `unsupported`
//! WITHOUT any inspector code change.
//!
//! ## Why a separate command (not an overload of `sessions.rs`)
//!
//! The session-store commands are pure disk reads via the SDK; this one spins a
//! transient SDK probe (no model turn) to read scope-aware config. Different cost
//! profile, different home — but the SAME query→reply→view shape as
//! [`crate::sidecar::sessions`], cloned here.
//!
//! ## The per-section tri-state
//!
//! Each section carries a `status` of `supported` (render its data, which may be
//! an empty list), `unsupported` ("Not available for this provider"), or
//! `unavailable` (a transient read failure → soft error + retry). The three are
//! DISTINCT; the views forward them verbatim so the web renders each correctly.

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::contracts::SurfaceQuery;
use crate::project::ProjectStore;

use super::query;

/// One MCP server in the inspector view. Mirrors the wire `McpServerSummary`:
/// the SDK's resolved, scope-aware set with live connection status. Exported to TS
/// as `McpServerSummary` for the bridge.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    test,
    ts(export, rename = "McpServerSummary", export_to = "McpServerSummary.ts")
)]
pub struct McpServerSummaryView {
    pub name: String,
    /// Connection status at probe time (surfaced verbatim).
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_count: Option<f64>,
}

/// One skill in the inspector view. Mirrors the wire `SkillSummary`.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    test,
    ts(export, rename = "SkillSummary", export_to = "SkillSummary.ts")
)]
pub struct SkillSummaryView {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One subagent in the inspector view. Mirrors the wire `SubagentSummary`.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    test,
    ts(export, rename = "SubagentSummary", export_to = "SubagentSummary.ts")
)]
pub struct SubagentSummaryView {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// One inspector section: its tri-state, an optional error (on `unavailable`),
/// and exactly one populated typed list (on `supported`). Mirrors the wire
/// `ProviderConfigSection`. The `status` is a plain string so the web's tri-state
/// union (`'supported' | 'unsupported' | 'unavailable'`) narrows it. Exported to
/// TS as `ProviderConfigSection`.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    test,
    ts(
        export,
        rename = "ProviderConfigSection",
        export_to = "ProviderConfigSection.ts"
    )
)]
pub struct ProviderConfigSectionView {
    /// `supported` / `unsupported` / `unavailable` (surfaced verbatim).
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<Vec<McpServerSummaryView>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<SkillSummaryView>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagents: Option<Vec<SubagentSummaryView>>,
}

/// The whole read-only inspector snapshot for one project. Mirrors the wire
/// `ProviderConfigSnapshot`. Exported to TS as `ProviderConfigSnapshot` for the
/// bridge.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    test,
    ts(
        export,
        rename = "ProviderConfigSnapshot",
        export_to = "ProviderConfigSnapshot.ts"
    )
)]
pub struct ProviderConfigSnapshotView {
    pub provider_id: String,
    pub provider_label: String,
    pub project_path: String,
    pub mcp: ProviderConfigSectionView,
    pub skills: ProviderConfigSectionView,
    pub subagents: ProviderConfigSectionView,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_style: Option<String>,
    /// Tri-state for the scalar extras group (surfaced verbatim).
    pub extras_status: String,
}

/// The active project's root path, used as the `dir` the inspector resolves
/// against (SDK config resolution keys off cwd). `None` when no project is active.
fn active_project_root(app: &AppHandle) -> Option<String> {
    app.state::<ProjectStore>().active().map(|p| p.path)
}

/// Extract the `error` string from a `query-result` reply for an `ok: false` case.
fn reply_error(reply: &Value) -> String {
    reply
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("provider-config query failed")
        .to_string()
}

/// Read the active provider's resolved configuration for a project (the read-only
/// inspector). `dir` defaults to the ACTIVE PROJECT root so the board-header entry
/// is per-project with no argument; pass an explicit `dir` to inspect another root.
/// Returns the snapshot (its sections degrade independently engine-side, so this
/// resolves with `ok: true` even when a section couldn't be read). Errors only when
/// no project is active or the transport itself failed.
#[tauri::command]
pub async fn get_provider_config(
    app: AppHandle,
    dir: Option<String>,
) -> Result<ProviderConfigSnapshotView, String> {
    let dir = dir.or_else(|| active_project_root(&app));
    let Some(dir) = dir else {
        return Err("no active project to inspect".to_string());
    };

    let reply = query(
        &app,
        SurfaceQuery::GetProviderConfig {
            request_id: String::new(),
            dir: Some(dir),
        },
    )
    .await?;
    if reply.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(reply_error(&reply));
    }

    let snapshot = reply
        .get("providerConfig")
        .ok_or("provider-config reply missing its snapshot")?;
    let snapshot: crate::contracts::ProviderConfigSnapshot =
        serde_json::from_value(snapshot.clone()).map_err(|e| e.to_string())?;
    let mut view = to_view(snapshot);
    // Nightcore owns Options.permissionMode — the value it passes to the SDK is
    // what the SDK will actually use, so the Settings-resolved value is
    // authoritative. The engine probe does not surface it (the SDK init response
    // carries model/outputStyle but not permissionMode), so we populate it
    // directly from the same resolver that wires each run.
    view.permission_mode = crate::sidecar::commands::resolve_permission_mode(&app, None);
    Ok(view)
}

/// Map one wire MCP summary to its view.
fn mcp_to_view(s: crate::contracts::McpServerSummary) -> McpServerSummaryView {
    McpServerSummaryView {
        name: s.name,
        status: s.status,
        scope: s.scope,
        transport: s.transport,
        tool_count: s.tool_count.map(|n| n as f64),
    }
}

/// Map one wire skill summary to its view.
fn skill_to_view(s: crate::contracts::SkillSummary) -> SkillSummaryView {
    SkillSummaryView {
        name: s.name,
        description: s.description,
    }
}

/// Map one wire subagent summary to its view.
fn subagent_to_view(s: crate::contracts::SubagentSummary) -> SubagentSummaryView {
    SubagentSummaryView {
        name: s.name,
        description: s.description,
        model: s.model,
    }
}

/// Map one wire section to its view (the typed list slots map element-wise).
fn section_to_view(s: crate::contracts::ProviderConfigSection) -> ProviderConfigSectionView {
    ProviderConfigSectionView {
        status: status_string(s.status),
        error: s.error,
        mcp_servers: s
            .mcp_servers
            .map(|v| v.into_iter().map(mcp_to_view).collect()),
        skills: s.skills.map(|v| v.into_iter().map(skill_to_view).collect()),
        subagents: s
            .subagents
            .map(|v| v.into_iter().map(subagent_to_view).collect()),
    }
}

/// The wire `ConfigSectionStatus` enum's string form, so the view forwards the
/// tri-state verbatim (the web narrows the plain string to its union).
fn status_string(status: crate::contracts::ConfigSectionStatus) -> String {
    use crate::contracts::ConfigSectionStatus::*;
    match status {
        Supported => "supported",
        Unsupported => "unsupported",
        Unavailable => "unavailable",
    }
    .to_string()
}

/// Map a wire `ProviderConfigSnapshot` to the board view.
fn to_view(snapshot: crate::contracts::ProviderConfigSnapshot) -> ProviderConfigSnapshotView {
    ProviderConfigSnapshotView {
        provider_id: snapshot.provider_id,
        provider_label: snapshot.provider_label,
        project_path: snapshot.project_path,
        mcp: section_to_view(snapshot.mcp),
        skills: section_to_view(snapshot.skills),
        subagents: section_to_view(snapshot.subagents),
        model: snapshot.model,
        permission_mode: snapshot.permission_mode,
        output_style: snapshot.output_style,
        extras_status: status_string(snapshot.extras_status),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{
        ConfigSectionStatus, McpServerSummary, ProviderConfigSection, ProviderConfigSnapshot,
        SkillSummary, SubagentSummary,
    };

    fn supported_section() -> ProviderConfigSection {
        ProviderConfigSection {
            status: ConfigSectionStatus::Supported,
            error: None,
            mcp_servers: Some(vec![McpServerSummary {
                name: "github".into(),
                status: "connected".into(),
                scope: Some("project".into()),
                transport: Some("stdio".into()),
                tool_count: Some(3),
            }]),
            skills: None,
            subagents: None,
        }
    }

    #[test]
    fn status_string_maps_every_tri_state() {
        assert_eq!(status_string(ConfigSectionStatus::Supported), "supported");
        assert_eq!(
            status_string(ConfigSectionStatus::Unsupported),
            "unsupported"
        );
        assert_eq!(
            status_string(ConfigSectionStatus::Unavailable),
            "unavailable"
        );
    }

    #[test]
    fn to_view_forwards_sections_and_extras() {
        let snapshot = ProviderConfigSnapshot {
            provider_id: "claude".into(),
            provider_label: "Claude".into(),
            project_path: "/proj".into(),
            mcp: supported_section(),
            skills: ProviderConfigSection {
                status: ConfigSectionStatus::Supported,
                error: None,
                mcp_servers: None,
                skills: Some(vec![SkillSummary {
                    name: "add-feature".into(),
                    description: None,
                }]),
                subagents: None,
            },
            subagents: ProviderConfigSection {
                status: ConfigSectionStatus::Unavailable,
                error: Some("probe timed out".into()),
                mcp_servers: None,
                skills: None,
                subagents: None,
            },
            model: Some("claude-opus-4-8".into()),
            permission_mode: Some("acceptEdits".into()),
            output_style: Some("default".into()),
            extras_status: ConfigSectionStatus::Supported,
        };

        let view = to_view(snapshot);
        assert_eq!(view.provider_id, "claude");
        assert_eq!(view.mcp.status, "supported");
        assert_eq!(
            view.mcp.mcp_servers.as_ref().unwrap()[0].tool_count,
            Some(3.0)
        );
        assert_eq!(
            view.mcp.mcp_servers.as_ref().unwrap()[0]
                .transport
                .as_deref(),
            Some("stdio")
        );
        assert_eq!(view.skills.status, "supported");
        assert_eq!(view.subagents.status, "unavailable");
        assert_eq!(view.subagents.error.as_deref(), Some("probe timed out"));
        assert_eq!(view.extras_status, "supported");
        assert_eq!(view.model.as_deref(), Some("claude-opus-4-8"));
    }

    /// When the engine probe snapshot has `permission_mode: None` (the probe cannot
    /// know it — the SDK init response doesn't carry it), `to_view` produces a view
    /// with `permission_mode: None`. The `get_provider_config` handler then
    /// overwrites it via `resolve_permission_mode` so the inspector shows the
    /// Nightcore-resolved value that actually controls each run.
    #[test]
    fn permission_mode_is_none_from_engine_snapshot() {
        let section = ProviderConfigSection {
            status: ConfigSectionStatus::Unsupported,
            error: None,
            mcp_servers: None,
            skills: None,
            subagents: None,
        };
        let snapshot = ProviderConfigSnapshot {
            provider_id: "claude".into(),
            provider_label: "Claude".into(),
            project_path: "/proj".into(),
            mcp: section.clone(),
            skills: section.clone(),
            subagents: section.clone(),
            model: None,
            permission_mode: None, // engine probe never sets this
            output_style: None,
            extras_status: ConfigSectionStatus::Unsupported,
        };
        let view = to_view(snapshot);
        assert!(
            view.permission_mode.is_none(),
            "to_view forwards the probe's absent permission_mode; the handler \
             overrides it from resolve_permission_mode post-mapping"
        );
    }

    /// A `SubagentSummary` with a missing/empty optional maps to an omitted view
    /// field (mirrors the wire `.optional()` shape).
    #[test]
    fn subagent_view_omits_absent_optionals() {
        let view = subagent_to_view(SubagentSummary {
            name: "Explore".into(),
            description: None,
            model: None,
        });
        assert_eq!(view.name, "Explore");
        assert!(view.description.is_none());
        assert!(view.model.is_none());
    }
}
