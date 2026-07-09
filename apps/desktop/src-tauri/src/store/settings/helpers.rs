//! Free helper functions backing the store: permission-mode / model-id / run-mode
//! mapping and the owner-only settings-file read/write primitives.

use std::path::Path;

use crate::contracts::{AutonomyLevel, KnownModel};

use super::model::Settings;

/// Parse a stored Nightcore autonomy setting string into the neutral wire
/// [`AutonomyLevel`] the `start-session` command now carries (issue #18, Phase 3).
/// The settings vocabulary IS the neutral vocabulary (`bypass | auto-accept | ask |
/// plan`), so this is a fail-safe parse — NOT a mapping to SDK modes; that lowering
/// now happens inside the Claude provider on the engine side.
///
/// An unrecognized value resolves to `bypass` — the studio's default is unattended
/// operation (the autonomous-studio choice; a task that wants prompts sets
/// `ask`/`plan` explicitly). Kept fail-safe (never an error) so a legacy or
/// hand-edited settings value can't wedge a launch.
pub fn parse_autonomy(raw: &str) -> AutonomyLevel {
    match raw {
        "auto-accept" => AutonomyLevel::AutoAccept,
        "ask" => AutonomyLevel::Ask,
        "plan" => AutonomyLevel::Plan,
        // "bypass" and any unrecognized/legacy value → unattended default.
        _ => AutonomyLevel::Bypass,
    }
}

/// The canonical wire string for an [`AutonomyLevel`] — the inverse of
/// [`parse_autonomy`], matching the codegen'd serde `kebab-case` rename verbatim.
/// Used where a plain string is needed for display (the provider-config inspector);
/// keeping it a total match means it can never diverge from the enum silently.
pub fn autonomy_wire_str(autonomy: AutonomyLevel) -> &'static str {
    match autonomy {
        AutonomyLevel::Bypass => "bypass",
        AutonomyLevel::AutoAccept => "auto-accept",
        AutonomyLevel::Ask => "ask",
        AutonomyLevel::Plan => "plan",
    }
}

/// The canonical wire id for a codegen'd [`KnownModel`], READ from its serde form
/// (issue #18, item 4). The `@nightcore/contracts` `KnownModelSchema` is the single
/// source of the catalog; this derives the long id from the generated enum instead
/// of re-listing the family strings, so a contract rename flows through here (and
/// the web, which consumes the same `KnownModelSchema`) with no Rust literal to
/// update. Infallible: a fieldless serde-`rename` enum always serializes to its
/// string.
pub fn known_model_id(model: KnownModel) -> String {
    match serde_json::to_value(model) {
        Ok(serde_json::Value::String(s)) => s,
        // Unreachable for a string-valued enum; a defensive fallback keeps the
        // resolver total rather than panicking in the settings hot path.
        _ => "claude-opus-4-8".to_string(),
    }
}

/// The default model id for the agent `provider` (issue #79/#80, B2). Provider-aware
/// so a non-Claude provider never silently falls through to a Claude model:
///
///  - `claude` → the first [`KnownModel`], single-sourced from the contract
///    (`claude-opus-4-8`). This is also the arm any UNKNOWN id lands in, because the
///    provider factory treats an unrecognized id as Claude (it falls back to the
///    Claude backend with a loud warning — see `provider::factory`), so a Claude
///    model is the correct default for it.
///  - `codex` → `gpt-5-codex`, the SDK-backed fallback/default used when no
///    explicit dynamic Codex model has been selected yet.
///
/// A new non-Claude provider that ships a static default adds an arm here; until then
/// it inherits the Claude arm's default (harmless — an unwired provider runs on the
/// Claude backend). Takes a `&str` rather than the `provider::CLAUDE_PROVIDER_ID`
/// const because `store` may not import the `provider` layer sideways (the layer-rank
/// rule) — the same reason [`super::model`]'s `default_provider` keeps a `"claude"`
/// literal.
pub fn default_model_id(provider: &str) -> String {
    match provider {
        "codex" => "gpt-5-codex".to_string(),
        // `claude` and any unrecognized id (the factory falls back to the Claude
        // backend) → the contract's first `KnownModel`.
        _ => known_model_id(KnownModel::ClaudeOpus48),
    }
}

/// Canonicalize a stored model id to a known long id (the value the engine sends on
/// the wire). Settings now persist long ids directly, but a settings file written
/// before P0 holds a SHORT id (`opus-4.8` / `sonnet-4.6` / `haiku-4.5`); map those
/// by family to the matching codegen'd [`KnownModel`] so legacy config still resolves
/// to a valid model. An already-canonical (`claude-…`) or unrecognized id passes
/// through unchanged (the SDK accepts any model string; a custom id is the user's own
/// choice).
///
/// Only the FAMILY tokens are matched here; the long ids come from the contract via
/// [`known_model_id`], so the catalog itself is single-sourced (this only fires for
/// pre-P0 persisted settings).
///
/// Deliberately a PASS-THROUGH for foreign-provider ids (issue #79/#80, B2): a Codex
/// model id (`gpt-5-codex`, `o3`, …) matches none of the Claude family tokens and is
/// returned verbatim — a non-Claude id is never rewritten into a Claude enum value.
/// An empty legacy id likewise passes straight through so the task creation layer
/// can treat it as "inherit" instead of stamping `Some("")`.
pub fn canonical_model_id(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("claude-") {
        return raw.to_string();
    }
    let known = if lower.contains("opus") {
        KnownModel::ClaudeOpus48
    } else if lower.contains("sonnet") {
        KnownModel::ClaudeSonnet46
    } else if lower.contains("haiku") {
        KnownModel::ClaudeHaiku45
    } else if lower.contains("fable") {
        KnownModel::ClaudeFable5
    } else {
        return raw.to_string();
    };
    known_model_id(known)
}

/// Parse a `default_run_mode` setting string into a [`RunMode`]. Fail-safe: an
/// unrecognized value resolves to `Main` so worktrees are never silently the
/// default. Reuses the enum's serde mapping so accepted strings can't drift.
pub(super) fn parse_run_mode(raw: &str) -> crate::task::RunMode {
    match raw {
        "worktree" => crate::task::RunMode::Worktree,
        _ => crate::task::RunMode::Main,
    }
}

pub(super) fn read_settings(path: &Path) -> Option<Settings> {
    let raw = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&raw) {
        Ok(value) => Some(value),
        Err(e) => {
            // Quarantine the unparsable file BEFORE the caller falls back to defaults:
            // otherwise the next settings write persists those defaults over it and the
            // user's settings (incl. plaintext MCP env/headers secrets) are lost for good.
            match crate::store::quarantine_corrupt(path) {
                Ok(backup) => {
                    tracing::warn!(target: "nightcore::settings", path = %path.display(), backup = %backup.display(), error = %e, "cannot parse settings; quarantined the file and using defaults")
                }
                Err(rename_err) => {
                    tracing::error!(target: "nightcore::settings", path = %path.display(), error = %e, rename_error = %rename_err, "cannot parse settings and failed to quarantine it; defaults may overwrite it on next save")
                }
            }
            None
        }
    }
}

pub(super) fn write_settings(path: &Path, settings: &Settings) -> Result<(), String> {
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
