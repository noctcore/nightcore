//! Free helper functions backing the store: permission-mode / model-id / run-mode
//! mapping and the owner-only settings-file read/write primitives.

use std::path::Path;

use crate::contracts::AutonomyLevel;

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
