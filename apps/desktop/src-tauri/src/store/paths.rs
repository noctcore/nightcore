//! Path safety + workspace-root resolution for the store.

use std::path::PathBuf;

/// Whether a task id is a safe filename component (defence in depth against path
/// traversal at the `<id>.json` join). Ids are server-minted uuids, but the id
/// also arrives from the wire on commands; an id carrying `.` / `/` / `\` (or any
/// path separator) could escape the tasks dir, so reject anything that isn't a
/// flat `[A-Za-z0-9_-]+` token. Empty is rejected too. Shared with `transcript.rs`.
pub(crate) fn is_safe_task_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The app's bundle identifier — the leaf subdir Tauri appends under the OS
/// app-data root for `app_local_data_dir()`. Single-sourced from `tauri.conf.json`'s
/// `identifier` so the AppHandle-less runtime base below lands in the same place the
/// AppHandle-threaded sidecar cwd (`lib.rs` setup) uses.
const APP_IDENTIFIER: &str = "dev.shirone.nightcore";

/// The default base under which the store keeps `.nightcore/` and (in dev) the
/// sidecar is spawned. Resolved at RUNTIME per whether this process is a packaged
/// bundle — see [`workspace_root_for`].
///
/// M1 keeps tasks under this project's `.nightcore/`; note the boot default is
/// immediately re-targeted at the active project's dir (`lib.rs` setup), so this only
/// governs the never-active-project scratch base.
pub fn workspace_root() -> PathBuf {
    workspace_root_for(crate::platform::running_as_bundle())
}

/// Injectable-seam form of [`workspace_root`]: `is_bundle` is the bundle signal
/// (a bare bool so tests can simulate a bundle without a real `.app`).
///
/// - **Dev (`false`, `tauri dev` / `cargo run`):** the compile-time repo root
///   (`apps/desktop/src-tauri` → up three). This is the REAL path on the dev
///   machine and is needed to find the TS sidecar entry + a dev-local `.nightcore`.
/// - **Bundle (`true`, release OR `tauri build --debug`):** a real on-disk runtime
///   data dir. It must NEVER be the compile-time `CARGO_MANIFEST_DIR` path: in a CI
///   build that is the BUILD machine's path (`/Users/runner/work/nightcore/…`),
///   which does not exist on a user's machine — chdir-ing the sidecar there fails
///   with ENOENT and the sidecar never comes up (the v0.2.0 regression this fixes).
pub fn workspace_root_for(is_bundle: bool) -> PathBuf {
    if is_bundle {
        runtime_data_base()
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
    }
}

/// A guaranteed-writable runtime data dir, resolved WITHOUT a Tauri `AppHandle`
/// (the store leaf has none). Mirrors `app_local_data_dir()` — the OS per-user
/// local-data root plus the app identifier — so the AppHandle-less boot default and
/// the AppHandle-threaded sidecar cwd agree. Falls back to the OS temp dir when the
/// home/data root is unresolvable, so it is always a real, existing-or-creatable
/// path — never the compile-time build path.
fn runtime_data_base() -> PathBuf {
    os_local_data_root()
        .map(|root| root.join(APP_IDENTIFIER))
        .unwrap_or_else(std::env::temp_dir)
}

/// The OS per-user local-data root that Tauri's `app_local_data_dir()` builds on
/// before appending the identifier: `$HOME/Library/Application Support` (macOS),
/// `%LOCALAPPDATA%` (Windows), `$XDG_DATA_HOME` or `$HOME/.local/share` (Linux/other
/// unix). `None` when the needed home/env var is unset (caller falls back to temp).
fn os_local_data_root() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let root = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let root =
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let root = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    root
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_base_is_the_compile_time_repo_root() {
        // Dev behavior is unchanged: NOT a bundle → the compile-time repo root, which
        // is the real path on the dev machine (needed for the TS sidecar entry + a
        // dev-local `.nightcore`). This pins that the fix doesn't regress dev.
        let compile_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        assert_eq!(workspace_root_for(false), compile_root);
    }

    #[test]
    fn bundle_base_is_a_runtime_path_not_the_compile_time_build_dir() {
        // The v0.2.0 regression: a CI-built release baked the BUILD machine's
        // `CARGO_MANIFEST_DIR` (`/Users/runner/work/nightcore/…`) as the workspace
        // root, so at runtime the sidecar chdir'd into a nonexistent dir and never
        // came up. Under the bundle signal the resolved base MUST be a runtime dir —
        // never the compile-time manifest dir or anything under it.
        let bundle_base = workspace_root_for(true);
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let compile_root = manifest.join("../../..");

        assert_ne!(
            bundle_base, compile_root,
            "bundle base must not be the compile-time repo root"
        );
        assert!(
            !bundle_base.starts_with(&manifest),
            "bundle base {bundle_base:?} must not live under the compile-time manifest dir {manifest:?}"
        );
        assert!(
            bundle_base.is_absolute(),
            "bundle base must be an absolute runtime location: {bundle_base:?}"
        );
        // It carries the app identifier (the app-data leaf) unless HOME/data root was
        // unresolvable, in which case it is the OS temp dir — both are valid runtime
        // dirs, neither is the build path.
        assert!(
            bundle_base.ends_with(APP_IDENTIFIER) || bundle_base.starts_with(std::env::temp_dir()),
            "bundle base is either <os-data>/<identifier> or the temp fallback: {bundle_base:?}"
        );
    }
}
