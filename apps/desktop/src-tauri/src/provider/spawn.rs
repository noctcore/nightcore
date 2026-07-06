//! Sidecar process spawn + release-binary path resolution for [`SidecarProvider`].
//!
//! The bundled-app vs `tauri dev` split lives here: a packaged `.app` spawns the
//! compiled sidecar Tauri placed next to the executable; a raw `tauri dev` run
//! spawns `bun run` against the TypeScript entry.

use super::*;

use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Command;

use crate::platform::resolve_bun_program;

/// The compiled sidecar binary's base name. Tauri's `externalBin` config copies
/// `binaries/nightcore-sidecar-<target-triple>` next to the app executable under
/// this name (no triple suffix at the install site). On Windows it carries `.exe`.
const SIDECAR_BIN: &str = "nightcore-sidecar";

impl SidecarProvider {
    /// Resolve the compiled sidecar binary that Tauri's `externalBin` places next
    /// to the app executable, if it exists. Tauri copies the triple-suffixed
    /// `binaries/nightcore-sidecar-<triple>` to a plain `nightcore-sidecar`
    /// (`.exe` on Windows) in the executable's directory — on macOS that is
    /// `Nightcore.app/Contents/MacOS/`, the same dir as the app binary. Returns
    /// `None` if the current exe or the binary can't be resolved, so the caller can
    /// fall back to `bun run` instead of dead-ending.
    pub(super) fn release_sidecar_path() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        let name = if cfg!(windows) {
            format!("{SIDECAR_BIN}.exe")
        } else {
            SIDECAR_BIN.to_string()
        };
        let path = dir.join(name);
        path.exists().then_some(path)
    }

    /// Whether the process is running from inside a packaged app bundle (debug OR
    /// release) rather than a raw `tauri dev` target binary. A bundled app must spawn
    /// the sidecar Tauri placed next to the executable; only a genuine `tauri dev`
    /// run wants `bun run` against the live TypeScript for hot reload.
    ///
    /// We can't key this off `cfg!(debug_assertions)` alone: `tauri build --debug`
    /// produces a *debug* build that is nonetheless a real bundle, and it copies the
    /// compiled sidecar into the `.app` — so a debug bundle that fell through to the
    /// dev path would try `bun run` against TypeScript that isn't there (and a GUI
    /// launch has no `bun` on PATH), failing with `os error 2`. macOS detects the
    /// `<App>.app/Contents/MacOS/<exe>` layout directly; other platforms fall back to
    /// the build profile (release ⇒ bundled), preserving prior behavior.
    fn running_as_bundle() -> bool {
        #[cfg(target_os = "macos")]
        {
            if let Ok(exe) = std::env::current_exe() {
                if Self::exe_in_app_bundle(&exe) {
                    return true;
                }
            }
        }
        !cfg!(debug_assertions)
    }

    /// Pure classifier for [`running_as_bundle`]: is `exe` inside a macOS `.app`
    /// bundle? A debug bundle lives under `target/debug/bundle/macos/<App>.app/…`, so
    /// the target-dir path is NOT a reliable "dev" signal — only an `.app` ancestor
    /// is. Extracted so the layout logic is unit-testable without a real executable.
    #[cfg(target_os = "macos")]
    pub(super) fn exe_in_app_bundle(exe: &std::path::Path) -> bool {
        exe.ancestors()
            .any(|ancestor| ancestor.extension().is_some_and(|ext| ext == "app"))
    }

    /// Build the (unspawned) [`Command`] for the sidecar, with program, args, and
    /// working directory set — but no stdio/spawn, which [`spawn`](Self::spawn)
    /// owns. The bundled/dev split is the only thing that varies here:
    ///
    /// - **Bundled app (`tauri build`, release OR `--debug`):** the compiled binary
    ///   Tauri placed next to the app executable. If it can't be resolved
    ///   (missing/unbundled), fall back to `bun run <entry>` with a warning so the
    ///   app degrades instead of failing to start.
    /// - **`tauri dev`:** `bun run <entry>` against the TypeScript source — the hot
    ///   path, so sidecar edits reload without a recompile.
    pub(super) fn spawn_command(&self) -> Command {
        if Self::running_as_bundle() {
            if let Some(bin) = Self::release_sidecar_path() {
                let mut cmd = Command::new(bin);
                cmd.current_dir(&self.cwd);
                self.inject_provider(&mut cmd);
                return cmd;
            }
            tracing::warn!(
                target: "sidecar",
                entry = %self.entry.display(),
                "running as an app bundle but the sidecar binary wasn't found next to \
                 the app executable; falling back to `bun run` against the TypeScript entry"
            );
        }
        let bun = resolve_bun_program();
        let mut cmd = Command::new(&bun.program);
        cmd.args(&bun.prefix_args)
            .arg("run")
            .arg(&self.entry)
            .current_dir(&self.cwd);
        self.inject_provider(&mut cmd);
        cmd
    }

    /// Pass the selected agent-provider id to the sidecar via the `NIGHTCORE_PROVIDER`
    /// env override (issue #18). The engine's `resolveConfig` reads it as the
    /// highest-precedence provider source, so its factory constructs the matching
    /// implementation (`codex` → the degraded Codex spike). Set for every provider,
    /// including `claude`, so the child's provider is always explicit — no secret or
    /// prompt is ever placed in the environment.
    fn inject_provider(&self, cmd: &mut Command) {
        cmd.env("NIGHTCORE_PROVIDER", &self.provider_id);
    }

    /// Spawn the sidecar child, store its stdin writer, and return its stdout +
    /// stderr for the caller to install readers on. Idempotent: returns `Ok(None)`
    /// when the child is already running. Holds the stdin lock for the spawn.
    ///
    /// **stderr is piped, not inherited** (M4.5 §B4): the sidecar's structured
    /// leveled lines would otherwise be thrown uncaptured at the host terminal. The
    /// caller drains stderr into the Rust `tracing` sink. stdout stays the pure
    /// NDJSON protocol — only stderr carries logs.
    pub async fn spawn(&self) -> Result<Option<SidecarStreams>, String> {
        let mut guard = self.stdin.lock().await;
        if guard.is_some() {
            return Ok(None);
        }

        let started = std::time::Instant::now();
        let mut child = self
            .spawn_command()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!(
                    "failed to spawn sidecar (release: the bundled `nightcore-sidecar` \
                 next to the app executable must be launchable; dev: a launchable bun \
                 binary must be found — on Windows, bun.exe must be on PATH or reachable \
                 via the npm shim): {e}"
                )
            })?;
        // Sidecar process lifecycle (#4) + spawn latency (#5). The pid + duration are
        // operational facts — no prompt/env/secret is logged.
        tracing::info!(
            target: "sidecar",
            pid = child.id(),
            duration_ms = started.elapsed().as_millis() as u64,
            "sidecar process spawned"
        );

        let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("sidecar stderr unavailable")?;
        *guard = Some(stdin);

        // Keep the child alive for the app's lifetime by detaching it onto a task
        // that just owns the handle; the readers (installed by the caller on the
        // returned streams) are what actually drain it.
        tokio::spawn(async move {
            let _child = child;
            std::future::pending::<()>().await;
        });

        Ok(Some(SidecarStreams { stdout, stderr }))
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::path::Path;

    fn in_bundle(p: &str) -> bool {
        SidecarProvider::exe_in_app_bundle(Path::new(p))
    }

    #[test]
    fn release_bundle_layout_is_a_bundle() {
        // The canonical installed layout: `<App>.app/Contents/MacOS/<exe>`.
        assert!(in_bundle(
            "/Applications/Nightcore.app/Contents/MacOS/nightcore"
        ));
    }

    #[test]
    fn debug_bundle_under_target_is_still_a_bundle() {
        // `tauri build --debug` produces a real `.app` nested under the target dir;
        // the `target/debug` prefix must NOT override the `.app` ancestor signal.
        assert!(in_bundle(
            "/repo/apps/desktop/src-tauri/target/debug/bundle/macos/Nightcore.app/Contents/MacOS/nightcore"
        ));
    }

    #[test]
    fn raw_dev_target_binary_is_not_a_bundle() {
        // A plain `tauri dev` / `cargo run` binary sitting in the target dir.
        assert!(!in_bundle(
            "/repo/apps/desktop/src-tauri/target/debug/nightcore"
        ));
        assert!(!in_bundle(
            "/repo/apps/desktop/src-tauri/target/release/nightcore"
        ));
    }

    #[test]
    fn app_must_be_an_extension_not_a_substring() {
        // A directory that merely contains "app" in its name is not a bundle;
        // only a literal `.app` extension on an ancestor counts.
        assert!(!in_bundle("/Users/dev/myapp/build/nightcore"));
        assert!(!in_bundle("/opt/apps/nightcore/bin/nightcore"));
    }

    #[test]
    fn app_extension_anywhere_in_ancestry_counts() {
        // The `.app` need not be the immediate grandparent — any ancestor suffices.
        assert!(in_bundle(
            "/Applications/Nightcore.app/Contents/MacOS/helpers/inner/nightcore"
        ));
    }
}
