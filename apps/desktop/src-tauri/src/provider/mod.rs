//! The provider seam (M2 §7 of the design doc).
//!
//! The seam between the Rust core and an agent backend is the **sidecar process
//! boundary**: each provider is a separate sidecar speaking the one NDJSON
//! `SurfaceCommand`/`NightcoreEvent` protocol. This trait is the Rust-side
//! abstraction. M2 ships exactly one implementation ([`SidecarProvider`], wrapping
//! the persistent Bun child); a Codex/other provider later is an additive sidecar
//! binary + factory arm, never a `match provider` branch in the core. The core
//! only ever consumes the normalized `NightcoreEvent` stream.
//!
//! ## Session ↔ task correlation
//!
//! The engine assigns a session id and echoes it back via a `session-started`
//! **event** — there is no synchronous reply to `start-session`. To run N sessions
//! concurrently through one sidecar, the provider keeps a **pending-launch FIFO**:
//! `start_session` pushes the task id under the same lock that serializes the
//! stdin write, so the i-th `start-session` line and the i-th `session-started`
//! event line line up (stdout is ordered; the engine emits `session-started`
//! synchronously, in command order). The reader calls [`correlate`] on the first
//! sighting of a session id to bind it to the task that launched it. This needs
//! **zero sidecar changes** — the sidecar stays dumb.
//!
//! Split by concern: the seam TYPES ([`Provider`] trait, [`Guardrails`],
//! [`PermissionDecision`], [`SidecarProvider`] + `Correlation`/`SidecarStreams`)
//! live in [`types`]; the `impl` blocks are split across [`imp`] (protocol
//! commands + line parsing), [`correlation`] (session↔task state), and [`spawn`]
//! (child process resolution).

mod correlation;
mod factory;
mod imp;
mod spawn;
mod types;

// Glob-reexport facade so external `provider::*` call sites resolve unchanged after
// the split (mirrors `sidecar/mod.rs`). `correlation`/`spawn` carry only inherent
// `impl SidecarProvider` methods — no free items to re-export yet — so they're
// `allow(unused_imports)`; `imp` re-exports `parse_line`. The seam types live in
// `types.rs` (issue #17 phase D — keeps this module a manifest); `Correlation` is
// `pub(super)`, re-bound below so the sibling impls reach it as `super::Correlation`.
#[allow(unused_imports)]
pub use correlation::*;
pub use factory::*;
pub use imp::*;
#[allow(unused_imports)]
pub use spawn::*;
pub use types::*;
// `Correlation` is `pub(super)` (internal), so a private re-binding — the sibling
// impls reach it as `super::Correlation` via their `use super::*`.
use types::Correlation;

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::Value;
    use tokio::sync::oneshot;

    use super::*;

    fn provider() -> SidecarProvider {
        SidecarProvider::new(
            PathBuf::from("/tmp/entry.ts"),
            PathBuf::from("/tmp"),
            "claude".to_string(),
        )
    }

    // Session↔task correlation behaviors are unit-tested co-located with their code
    // in `correlation.rs`; the tests below cover the spawn resolver (`spawn.rs`) and
    // the line parser / query-reply plumbing (`imp.rs`).

    #[test]
    fn dev_build_spawns_bun_run_against_the_entry() {
        // The test harness is a debug build, so `spawn_command` must take the dev
        // path: `bun run <entry>`, with the entry TS file in the args (not the
        // compiled binary). This pins the release-packaging fix from regressing the
        // hot dev path.
        let p = provider();
        let cmd = p.spawn_command();
        let args: Vec<_> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(
            args.iter().any(|a| a == "run"),
            "dev spawn must invoke `bun run`: {args:?}"
        );
        assert!(
            args.iter().any(|a| a == "/tmp/entry.ts"),
            "dev spawn must target the TypeScript entry: {args:?}"
        );
    }

    #[test]
    fn release_sidecar_path_is_none_when_no_binary_is_bundled() {
        // No `nightcore-sidecar` is bundled next to the test runner, so the release
        // resolver must return None — which is what makes `spawn_command` fall back
        // to `bun run` instead of dead-ending on a missing binary.
        assert!(
            SidecarProvider::release_sidecar_path().is_none(),
            "no bundled sidecar exists next to the test binary"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn detects_a_macos_app_bundle_exe() {
        use std::path::Path;
        // A release bundle and a `tauri build --debug` bundle both put the exe inside
        // a `.app` — both must be treated as bundled so the sidecar binary is used.
        assert!(SidecarProvider::exe_in_app_bundle(Path::new(
            "/Applications/Nightcore.app/Contents/MacOS/nightcore"
        )));
        assert!(
            SidecarProvider::exe_in_app_bundle(Path::new(
                "/repo/apps/desktop/src-tauri/target/debug/bundle/macos/Nightcore.app/Contents/MacOS/nightcore"
            )),
            "a debug bundle under target/debug is still an .app bundle — must use the bundled sidecar"
        );
        // `tauri dev` runs the raw target binary — NOT a bundle, so it falls through
        // to `bun run` for hot reload.
        assert!(!SidecarProvider::exe_in_app_bundle(Path::new(
            "/repo/apps/desktop/src-tauri/target/debug/nightcore"
        )));
    }

    #[test]
    fn parse_line_skips_blanks_and_reports_bad_json() {
        assert!(parse_line("   ").is_none());
        assert!(parse_line(r#"{"type":"x"}"#).unwrap().is_ok());
        assert!(parse_line("{not json").unwrap().is_err());
    }

    #[tokio::test]
    async fn correlate_reply_fulfills_a_pending_query() {
        // A query registers a pending one-shot under its request id; the reader's
        // `correlate_reply` delivers the matching reply to the awaiting receiver.
        let p = provider();
        let (tx, rx) = oneshot::channel::<Value>();
        p.pending_replies
            .lock()
            .unwrap()
            .insert("req-1".to_string(), tx);

        p.correlate_reply("req-1", serde_json::json!({"ok": true}));
        let reply = rx.await.expect("the pending sender delivered the reply");
        assert_eq!(reply, serde_json::json!({"ok": true}));
        // The entry is consumed, so a second correlate is a no-op.
        assert!(p.pending_replies.lock().unwrap().is_empty());
    }

    #[test]
    fn correlate_reply_for_unknown_id_is_a_noop() {
        // A `query-result` whose request id has no pending entry (timed out, or a
        // stray reply) is dropped without panicking.
        let p = provider();
        p.correlate_reply("ghost", serde_json::json!({"ok": false}));
        assert!(p.pending_replies.lock().unwrap().is_empty());
    }
}
