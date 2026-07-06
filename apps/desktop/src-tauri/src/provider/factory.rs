//! The config-driven provider factory (issue #18).
//!
//! The ONE place a provider id → implementation mapping lives, so orchestration
//! never `match provider`es. Today `claude` is the only arm — the Bun sidecar
//! [`SidecarProvider`]; a future Codex/Gemini provider adds an arm here plus its own
//! sidecar binary, never a branch in the coordinator. An unknown id is an explicit
//! `Err` so a typo or a not-yet-implemented provider surfaces loudly; the caller
//! decides whether to fail hard or fall back (the orchestrator falls back to the
//! default Claude provider through this SAME factory).

use std::path::PathBuf;
use std::sync::Arc;

use super::SidecarProvider;

/// The stable id of the Claude Agent provider — the only shipped implementation.
/// Single-sourced here so the settings default ([`crate::settings`]) and the factory
/// arm below can't drift.
pub const CLAUDE_PROVIDER_ID: &str = "claude";

/// Build the provider named by `provider_id`, configured to spawn `bun run <entry>`
/// in `cwd` (the M1 shape). This is the single provider-selection point: `claude` →
/// the Bun [`SidecarProvider`]; any other id is an explicit `Err` so a typo or a
/// not-yet-implemented provider can never silently run the wrong backend.
///
/// Returns the concrete `SidecarProvider` because every shipped provider is a
/// sidecar speaking the one NDJSON protocol today; the `Arc<dyn Provider>`
/// generalization is deferred until a second arm actually needs it (Phase 4), when
/// the orchestrator's provider field also becomes trait-object-typed.
pub fn build_provider(
    provider_id: &str,
    entry: PathBuf,
    cwd: PathBuf,
) -> Result<Arc<SidecarProvider>, String> {
    match provider_id {
        CLAUDE_PROVIDER_ID => Ok(Arc::new(SidecarProvider::new(entry, cwd))),
        other => Err(format!(
            "unknown provider `{other}`: no such agent-provider implementation \
             (issue #18 ships only `{CLAUDE_PROVIDER_ID}`)"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> (PathBuf, PathBuf) {
        (PathBuf::from("/tmp/entry.ts"), PathBuf::from("/tmp"))
    }

    #[test]
    fn builds_the_claude_provider() {
        let (entry, cwd) = paths();
        assert!(
            build_provider(CLAUDE_PROVIDER_ID, entry, cwd).is_ok(),
            "the shipped `claude` arm must build"
        );
    }

    #[test]
    fn unknown_provider_is_an_explicit_error() {
        // `SidecarProvider` is not `Debug`, so match rather than `expect_err`.
        let (entry, cwd) = paths();
        match build_provider("codex", entry, cwd) {
            Ok(_) => panic!("an unknown provider id must be an explicit error"),
            Err(err) => assert!(
                err.contains("codex") && err.contains("unknown provider"),
                "the error names the offending id: {err}"
            ),
        }
    }
}
