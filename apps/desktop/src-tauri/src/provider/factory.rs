//! The config-driven provider factory (issue #18).
//!
//! The ONE place a provider id → implementation mapping lives, so orchestration
//! never `match provider`es. Every provider is the SAME Bun [`SidecarProvider`]
//! transport today — no second sidecar binary ships for Codex, so the
//! selected id is threaded to the child via the `NIGHTCORE_PROVIDER` env override and
//! the ENGINE-side factory constructs the matching implementation (`claude` → the
//! Claude provider, `codex` → the Codex provider). A future NATIVE second
//! sidecar binary would add an arm here that spawns a different entry; until then the
//! arms differ only by the provider id passed through. An unknown id is an explicit
//! `Err` so a typo can never silently run the wrong backend; the orchestrator falls
//! back to the default Claude provider through this SAME factory.

use std::path::PathBuf;
use std::sync::Arc;

use super::SidecarProvider;

/// The stable id of the Claude Agent provider — the default implementation.
/// Single-sourced here so the settings default ([`crate::settings`]) and the factory
/// arm below can't drift.
pub const CLAUDE_PROVIDER_ID: &str = "claude";

/// The stable id of the Codex provider. Shares the Bun sidecar transport; the
/// ENGINE-side factory maps it to `CodexAgentProvider`.
pub const CODEX_PROVIDER_ID: &str = "codex";

/// Build the provider named by `provider_id`, configured to spawn the sidecar in
/// `cwd` (the M1 shape). This is the single provider-selection point: the recognized
/// ids (`claude`, `codex`) build the Bun [`SidecarProvider`] carrying that id through
/// to the engine; any other id is an explicit `Err` so a typo or a not-yet-wired
/// provider can never silently run the wrong backend.
///
/// Returns the concrete `SidecarProvider` because every provider is a sidecar
/// speaking the one NDJSON protocol today — the Codex arm differs only by the
/// provider id it passes to the engine, not by transport. The `Arc<dyn Provider>`
/// generalization is deferred until a NATIVE second sidecar binary actually needs a
/// different concrete type.
pub fn build_provider(
    provider_id: &str,
    entry: PathBuf,
    cwd: PathBuf,
) -> Result<Arc<SidecarProvider>, String> {
    match provider_id {
        CLAUDE_PROVIDER_ID | CODEX_PROVIDER_ID => Ok(Arc::new(SidecarProvider::new(
            entry,
            cwd,
            provider_id.to_string(),
        ))),
        other => Err(format!(
            "unknown provider `{other}`: no such agent-provider implementation \
             (issue #18/#79 wire `{CLAUDE_PROVIDER_ID}` and `{CODEX_PROVIDER_ID}`)"
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
        let provider = build_provider(CLAUDE_PROVIDER_ID, entry, cwd)
            .expect("the default `claude` arm must build");
        assert_eq!(
            provider.provider_id, CLAUDE_PROVIDER_ID,
            "the claude arm threads its id through to the engine"
        );
    }

    #[test]
    fn builds_the_codex_provider_spike() {
        // The second-provider spike shares the sidecar transport; only the id it
        // passes to the engine (via NIGHTCORE_PROVIDER) differs.
        let (entry, cwd) = paths();
        let provider = build_provider(CODEX_PROVIDER_ID, entry, cwd)
            .expect("the `codex` spike arm must build");
        assert_eq!(
            provider.provider_id, CODEX_PROVIDER_ID,
            "the codex arm threads `codex` through so the engine factory picks it"
        );
    }

    #[test]
    fn unknown_provider_is_an_explicit_error() {
        // `SidecarProvider` is not `Debug`, so match rather than `expect_err`.
        let (entry, cwd) = paths();
        match build_provider("gemini", entry, cwd) {
            Ok(_) => panic!("an unknown provider id must be an explicit error"),
            Err(err) => assert!(
                err.contains("gemini") && err.contains("unknown provider"),
                "the error names the offending id: {err}"
            ),
        }
    }
}
