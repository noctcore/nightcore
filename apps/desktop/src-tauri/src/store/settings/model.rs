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
    /// "bypass" | "auto-accept" | "ask" | "plan" — the neutral autonomy vocabulary
    /// (issue #18). Parsed to the wire [`AutonomyLevel`](crate::contracts::AutonomyLevel)
    /// via [`parse_autonomy`]; the Claude provider lowers THAT to an SDK permission
    /// mode engine-side. Default is `bypass` (an autonomous studio runs without
    /// prompts; a per-task override re-enables them).
    pub permission_mode: String,
    /// The default agent provider for inherited task model picks. A lowercase
    /// provider id (`claude` / `codex`); explicit task-level `provider_id` wins, so
    /// different tasks can run on different providers in the same sidecar process.
    /// Serde-additive: a settings file written before this field loads as `"claude"`.
    #[serde(default = "default_provider")]
    pub provider: String,
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
    /// Auto Mode option: when the autonomous loop is running and this is enabled,
    /// the web observer fires the `commit_task` IPC for each task that reaches the
    /// verified state (`Done` + `verified`), so the loop commits its output as it
    /// goes. A main-mode task commits its working tree; a worktree-mode task whose
    /// build work was already committed pre-review is a benign "nothing to commit"
    /// skip. Global-only (like `cleanup_worktrees`/`notify_on_complete`) — there is
    /// no per-project override. Default `false` (opt-in). Serde-additive: a settings
    /// file written before this field loads as `false`.
    #[serde(default)]
    pub auto_commit_on_verified: bool,
    /// OS write containment (hardening module #15, tier "OS containment"): when
    /// enabled, every agent session launches with `sandboxWrites` on the
    /// `start-session` command, and the engine wraps the `claude` executable in a
    /// macOS Seatbelt deny-write-except profile — file writes outside the
    /// session's writable roots (cwd, worktree git common dir, temp trees, Claude
    /// CLI state) are blocked at the OS layer, closing the lexical PreToolUse
    /// gate's documented gaps (Bash redirects, symlinks). darwin-only: on other
    /// hosts (or if Seatbelt breaks) the engine logs a loud warning and runs
    /// unwrapped (fail-open). Global-only (like `auto_commit_on_verified`).
    /// Default `false` (opt-in, experimental). Serde-additive: a settings file
    /// written before this field loads as `false`.
    #[serde(default)]
    pub sandbox_sessions: bool,
    /// Sidebar layout preference: `"unified"` (default) or `"classic"`. Serde-additive:
    /// legacy settings load as `None` and resolve to unified at read time.
    #[serde(default)]
    pub sidebar_style: Option<String>,
    /// The user's preferred editor for the worktree "Open in editor" action — a
    /// known-editor command id (`code` / `cursor` / …, see
    /// [`crate::infra::editor::KNOWN_EDITORS`]). `None` ⇒ auto-detect the first
    /// installed known editor. Global-only (a machine/user preference, like
    /// `sidebar_style`). A stored value that isn't an installed allowlisted editor
    /// is ignored at launch time (resolution falls back to auto-detect), so the
    /// field can never make the opener spawn an arbitrary program. Serde-additive:
    /// a settings file written before this field loads as `None`.
    #[serde(default)]
    pub preferred_editor: Option<String>,
    /// USER terminal (build spec PR C, decision 7): opt into the xterm WebGL/GPU
    /// renderer. Default `false` (DOM) while the upstream WebGL corruption bug
    /// (xtermjs#5816, repro'd from Tauri) is open; when `true`, a new session loads
    /// the WebGL addon with an `onContextLoss` auto-fallback to DOM. Global-only (a
    /// machine/GPU preference, like `sidebar_style`/`sandbox_sessions`). Serde-
    /// additive: a settings file written before this field loads as `false`.
    #[serde(default)]
    pub terminal_webgl_enabled: bool,
    /// USER terminal (build spec PR C, decision 1): the sticky default for the
    /// new-tab picker's "Confined" checkbox (macOS-only opt-in Seatbelt write
    /// containment, scoped to the session cwd). The picker seeds the checkbox from
    /// this and writes the last choice back, so the preference persists across
    /// relaunches. Default `false` (unconfined — the human seam runs with full
    /// permissions). Global-only. Serde-additive: legacy settings load this `false`.
    #[serde(default)]
    pub terminal_confined_default: bool,
    /// USER terminal (cockpit spec PR 3, decision 6e): the xterm font size (px) for
    /// live sessions. `None` ⇒ the shipped 13px. A web render preference only — the
    /// Rust scrollback ring is unaffected; the session manager applies changes to
    /// live terminals reactively (`xterm.options.fontSize`). Global-only (a machine
    /// preference, like the other terminal knobs). The web clamps to a sane range
    /// before it lands here. Serde-additive: a settings file written before this
    /// field loads as `None`.
    #[serde(default)]
    pub terminal_font_size: Option<u16>,
    /// USER terminal (cockpit spec PR 3, decision 6e): the xterm scrollback length
    /// (lines) for live sessions. `None` ⇒ the shipped ~10k. A web render preference
    /// only — it sizes xterm's own web-side buffer, NOT the Rust persist ring (which
    /// stays ~10k regardless). Applied to live terminals reactively (new output).
    /// Global-only. Web-clamped. Serde-additive: legacy settings load this `None`.
    #[serde(default)]
    pub terminal_scrollback: Option<u32>,
    /// Provider usage meter (issue #121, spec decision 5): opt-in. When false
    /// (default), the sidebar widget shows a dormant "Enable usage meter" button and
    /// the Rust poll loop parks — zero network/Keychain access until the user opts
    /// in. Enabling reads OAuth credentials to call the providers' usage endpoints
    /// (read-only; never refreshes a token). Global-only (a machine/account
    /// preference, like `sandbox_sessions`). Serde-additive: a settings file written
    /// before this field loads as `false`.
    #[serde(default)]
    pub usage_meter_enabled: bool,
    /// USER terminal (cockpit spec PR 4, decision 3): the "YOLO" launch flag. When
    /// enabled, the web's one-click "Launch Claude" affordance appends
    /// `--dangerously-skip-permissions` to the composed launch command, so the
    /// `claude` started inside the terminal runs with no permission prompts. It
    /// changes ONLY the composed launch string — nothing about the PTY seam or
    /// confinement. DEFAULT `false` (opt-in; a Settings toggle carries an explicit
    /// warning). Global-only (a machine preference, like the other terminal knobs).
    /// Serde-additive: a settings file written before this field loads as `false`.
    #[serde(default)]
    pub terminal_yolo_launch: bool,
    /// USER terminal (cockpit spec PR 6, decision 7): opt into the **detached PTY
    /// daemon** so live shells survive an app restart. When `true` (and the platform
    /// supports it — macOS/Linux only in v1), unconfined sessions are owned by a
    /// separate detached process the app reattaches to over a local Unix socket on
    /// relaunch, replaying buffered output instead of a read-only scrollback restore.
    /// EXPERIMENTAL and DEFAULT `false`: every failure path (daemon absent, dead,
    /// version-skewed, or platform-unsupported) degrades to the shipped in-process
    /// PTY + read-only restore, so today's behavior is always the fallback. Confined
    /// (Seatbelt) sessions are daemon-EXEMPT — they stay in-process and die with the
    /// app even when this is on (§5.5). Global-only (a machine preference, like the
    /// other terminal knobs). Serde-additive: a settings file written before this
    /// field loads as `false`.
    #[serde(default)]
    pub terminal_daemon_enabled: bool,
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

/// The serde default for `provider` — the default shipped provider (issue #18). A
/// settings file written before the field loads as `"claude"`. Kept a literal (not
/// `crate::provider::CLAUDE_PROVIDER_ID`) because `store` may not import `provider`
/// sideways (the layer-rank rule). The factory's `claude` arm is the id authority;
/// a drifted default can't mis-launch — the factory falls back to Claude with a
/// loud warning on any id it doesn't recognize.
fn default_provider() -> String {
    "claude".to_string()
}

/// The serde default for `context_pack_enabled` (a legacy settings file without the
/// field loads as `true` — a project's authored Constitution is injected by default).
fn default_true() -> bool {
    true
}

/// The serde default for the board-appearance opacity knobs: fully opaque (`1.0`).
/// A settings file written before a given knob existed — or a `BoardAppearance`
/// object missing it — loads that knob at `1.0`, so the board renders exactly like
/// the pre-feature look (the whole feature is opt-in; nothing changes until the user
/// dials a knob down).
fn default_opacity() -> f64 {
    1.0
}

/// Per-project **board appearance** knobs (Custom Background feature): the card /
/// column translucency, border visibility + opacity, card glassmorphism blur, and
/// board-scrollbar hiding that let a project's Kanban board read over a custom
/// background image. Serde-additive and defaulted so an absent field (legacy file
/// or a forward-compat partial object) loads at the value that reproduces the
/// pre-feature look — the controls only visibly change the board once the user
/// adjusts them (or sets a background image). Knobs only; the image reference lives
/// in the sibling [`BoardBackgroundRef`] (managed by the dedicated image commands),
/// so a knob patch and an image change can never clobber each other.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "BoardAppearance.ts"))]
pub struct BoardAppearance {
    /// Card background opacity `0.0..=1.0`. `1.0` (default) ⇒ solid card (current
    /// look); lower values let the background image show through the card.
    #[serde(default = "default_opacity")]
    pub card_opacity: f64,
    /// Column panel opacity `0.0..=1.0`. `1.0` (default) ⇒ solid column panel.
    #[serde(default = "default_opacity")]
    pub column_opacity: f64,
    /// Whether column borders are drawn. `true` (default) ⇒ borders shown.
    #[serde(default = "default_true")]
    pub show_column_borders: bool,
    /// Whether card borders are drawn. `true` (default) ⇒ borders shown (status
    /// glow shadows are unaffected either way, so run/verify state stays legible).
    #[serde(default = "default_true")]
    pub show_card_borders: bool,
    /// Card glassmorphism (backdrop blur behind the card). `false` (default) ⇒ no
    /// blur (blur is a per-card render cost, so it's opt-in).
    #[serde(default)]
    pub card_glassmorphism: bool,
    /// Card border opacity `0.0..=1.0` when borders are shown. `1.0` (default) ⇒
    /// full-strength neutral border.
    #[serde(default = "default_opacity")]
    pub card_border_opacity: f64,
    /// Whether the horizontal board scrollbar is hidden. `false` (default) ⇒ shown.
    #[serde(default)]
    pub hide_board_scrollbar: bool,
}

impl Default for BoardAppearance {
    fn default() -> Self {
        // The identity appearance: every knob at the value that reproduces the
        // pre-feature board look. `BoardAppearance::default() == ` a project that
        // never touched the panel.
        Self {
            card_opacity: default_opacity(),
            column_opacity: default_opacity(),
            show_column_borders: true,
            show_card_borders: true,
            card_glassmorphism: false,
            card_border_opacity: default_opacity(),
            hide_board_scrollbar: false,
        }
    }
}

/// Per-project reference to a stored **board background image**. The bytes live on
/// disk under the OS app-data dir (`board-backgrounds/<project-id>/background.<ext>`,
/// see [`crate::store::board_background`]) — NOT inline in `settings.json` — so a
/// multi-MB gif never bloats the shared settings file. `format` names the file
/// extension + mime; `version` is bumped on every replace so the web can cache-bust
/// its `<img>`/CSS `background-image` when the bytes change under the same format.
/// Managed ONLY by the `set_board_background` / `clear_board_background` commands
/// (never by a settings patch), keeping it independent of the knob struct.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "BoardBackgroundRef.ts"))]
pub struct BoardBackgroundRef {
    /// Image format token (`png` | `jpeg` | `webp` | `gif`) — the on-disk file
    /// extension and the `data:` URL mime the web builds from it.
    pub format: String,
    /// Monotonic replace counter (starts at 1). Bumped on every set so the web
    /// re-reads the bytes even when a replacement keeps the same `format`.
    pub version: u64,
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
        // Derive the default model from the SAME provider the defaults ship with, so
        // the two fields can never diverge for a fresh install (issue #79/#80, B2): a
        // non-Claude provider gets its own default (never a Claude model), and today's
        // `claude` default keeps the first contract `KnownModel`.
        let provider = default_provider();
        Self {
            // The default model, single-sourced from the contract `KnownModel`
            // (issue #18, item 4) and now provider-aware — no longer a literal
            // duplicated with `canonical_model_id`. See `default_model_id` for the
            // per-provider policy and `canonical_model_id` for the legacy short-id
            // fallback so old settings files still resolve.
            default_model: super::helpers::default_model_id(&provider),
            default_effort: "medium".to_string(),
            max_concurrency: 3,
            // M4.7 §A1: bypass by default — new tasks run unattended with no
            // approval prompts. A per-task override re-enables prompting.
            permission_mode: "bypass".to_string(),
            // Issue #18: the Claude Agent is the default shipped provider.
            provider,
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
            // Auto Mode option: opt-in — the loop commits verified tasks only once
            // the user enables it in the Auto Mode options popover.
            auto_commit_on_verified: false,
            // Module #15: OS write containment is opt-in (experimental,
            // darwin-only) — sessions run unwrapped until the user enables it.
            sandbox_sessions: false,
            sidebar_style: None,
            // No editor pinned by default — the worktree "Open in editor" action
            // auto-detects the first installed known editor until the user picks one.
            preferred_editor: None,
            // PR C decision 7: DOM renderer by default (WebGL is opt-in while the
            // upstream corruption bug is open).
            terminal_webgl_enabled: false,
            // PR C decision 1: the human terminal is unconfined by default; the
            // confined checkbox starts off and remembers the user's last choice.
            terminal_confined_default: false,
            // Cockpit PR 3 decision 6e: no render-pref override by default — live
            // terminals use the shipped 13px font + ~10k web scrollback until the
            // user sets a value in the Terminal settings section.
            terminal_font_size: None,
            terminal_scrollback: None,
            // Issue #121 decision 5: the usage meter is opt-in — the poll loop parks
            // and no credential is read until the user clicks "Enable usage meter".
            usage_meter_enabled: false,
            // Cockpit PR 4 decision 3: YOLO launch off by default — the composed
            // "Launch Claude" command runs with normal permission prompts until the
            // user enables the (explicitly warned) toggle.
            terminal_yolo_launch: false,
            // Cockpit PR 6 decision 7: the detached PTY daemon is opt-in
            // (experimental) — every session stays in-process (dying with the app,
            // read-only-restored on relaunch) until the user enables it.
            terminal_daemon_enabled: false,
            project_overrides: HashMap::new(),
        }
    }
}

/// Resolve the persisted sidebar style (`"unified"` | `"classic"`). Unknown values
/// fall back to `"unified"` so a typo can't wedge the shell.
pub fn resolve_sidebar_style(style: Option<&str>) -> &'static str {
    match style {
        Some("classic") => "classic",
        _ => "unified",
    }
}
