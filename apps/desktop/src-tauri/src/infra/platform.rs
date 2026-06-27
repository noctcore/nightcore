//! Platform-aware process-launch resolution.
//!
//! The one cross-platform hazard that has actually broken Nightcore is launching
//! a tool by **bare program name** (`bun`, `npm`, `cargo`, `git`) with
//! `std::process::Command`. On macOS/Linux `which::which(name)` resolves the real
//! executable directly. On Windows the npm shims (`bun.cmd`, `bun.ps1`, an
//! extensionless POSIX script) are on PATH but Win32 `CreateProcess` cannot launch
//! them — `which` with PATHEXT awareness finds the real `.exe` when it exists; if
//! it doesn't, we route through `cmd /C <name>` so the shim IS usable.
//!
//! This module consolidates that resolution behind [`resolve_program`]. Spawn sites
//! launch the resolved [`Program`] via
//! `Command::new(prog.program).args(prog.prefix_args)…`, or via the [`std_command`]
//! convenience for the synchronous spawn sites. Consumers today: the sidecar `bun`
//! spawn (`orchestration/provider.rs`, async tokio), the readiness gauntlet's `bun`/`npm`/`cargo`
//! steps (`gauntlet.rs`), and the `git` calls in `orchestration/worktree.rs` + `project.rs`.

use std::path::PathBuf;

/// A resolved, launchable program: an absolute executable path plus any prefix
/// args needed to actually launch it. On macOS/Linux `prefix_args` is empty and
/// `program` is the real binary. On a Windows shim-only install the resolver may
/// return `program = "cmd"` with `prefix_args = ["/C", "<name>"]` so the npm shim
/// is reachable through the shell.
#[derive(Debug, Clone)]
pub struct Program {
    pub program: PathBuf,
    pub prefix_args: Vec<String>,
}

/// Resolve a launchable program by name. Returns an absolute path to the real
/// executable when `which` can find it (PATHEXT-aware on Windows, so `name.exe` is
/// preferred), otherwise a `cmd /C <name>` shell-routed fallback on Windows so an
/// npm shim is still launchable. On macOS/Linux `which` resolves the real binary
/// directly and the fallback is never taken; if `which` fails there we return the
/// bare `name` and let the OS error surface at spawn time.
pub fn resolve_program(name: &str) -> Program {
    match which::which(name) {
        Ok(path) => Program {
            program: path,
            prefix_args: vec![],
        },
        Err(_) => {
            // On Windows: route through cmd /C so the .cmd shim is usable when a
            // launchable .exe is not on PATH at all.
            #[cfg(windows)]
            {
                Program {
                    program: PathBuf::from("cmd"),
                    prefix_args: vec!["/C".to_string(), name.to_string()],
                }
            }
            // On non-Windows: fall back to the bare name and let the OS error
            // surface.
            #[cfg(not(windows))]
            {
                Program {
                    program: PathBuf::from(name),
                    prefix_args: vec![],
                }
            }
        }
    }
}

/// Resolve a launchable Bun program. Thin alias over [`resolve_program`] for the
/// sidecar-spawn hot path so its call site reads as `resolve_bun_program()`.
pub fn resolve_bun_program() -> Program {
    resolve_program("bun")
}

/// Build a synchronous [`std::process::Command`] for a bare program `name`, with
/// the resolved program + any prefix args already applied — the caller just adds
/// its own `.args(…)`, `.current_dir(…)`, etc. This is the ergonomic entry point
/// for the std-Command spawn sites (`git`, `cargo`, the gauntlet steps). The async
/// sidecar hot path uses [`resolve_bun_program`] directly because it needs a
/// `tokio::process::Command`, which this helper does not build.
pub fn std_command(name: &str) -> std::process::Command {
    let prog = resolve_program(name);
    let mut cmd = std::process::Command::new(prog.program);
    cmd.args(prog.prefix_args);
    cmd
}

/// Hydrate this process's `PATH` from the user's login shell so a GUI-launched app
/// (Finder / Dock) resolves the same tools the user has in a terminal — `bun`,
/// `cargo`, `node` (incl. nvm/asdf/fnm), Homebrew. macOS hands a GUI app launchd's
/// minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`); the per-user dirs (`~/.bun/bin`,
/// `~/.cargo/bin`, `/opt/homebrew/bin`) live in the shell profile, which a GUI launch
/// never sources. We spawn the sidecar (and through it the agent's Bash tool and the
/// readiness gauntlet) as children, so they'd all inherit that crippled PATH and fail
/// to find bun/cargo. Fixing it here, once, fixes every descendant.
///
/// No-op on Windows (its GUI PATH comes from the registry, and the npm-shim handling
/// in [`resolve_program`] already covers the bun case). Best-effort and bounded: only
/// when the current PATH looks minimal do we ask the login shell for its `$PATH`
/// (sentinel-delimited, 3s timeout, killed if it hangs); either way we union in the
/// well-known user-tool dirs that exist as a floor. Call ONCE, early in startup,
/// before any thread or child is spawned (so `set_var` is sound).
#[cfg(not(windows))]
pub fn hydrate_login_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    // Fast path: a terminal/dev launch already has a rich PATH (it inherited the
    // shell's). Skip the shell spawn there; only a minimal launchd PATH needs it.
    let looks_minimal = !current.contains("/.cargo/bin") && !current.contains("/homebrew/");
    let base = if looks_minimal {
        login_shell_path().unwrap_or_else(|| current.clone())
    } else {
        current.clone()
    };
    let merged = merge_paths(&base, &floor_dirs());
    if !merged.is_empty() && merged != current {
        std::env::set_var("PATH", &merged);
        tracing::info!(
            target: "nightcore::platform",
            entries = merged.split(':').count(),
            "hydrated PATH for GUI launch"
        );
    }
}

/// No-op on Windows — see [`hydrate_login_path`] (non-Windows).
#[cfg(windows)]
pub fn hydrate_login_path() {}

/// Ask the user's login shell for its `$PATH`. Runs `$SHELL -lic` so the profile is
/// sourced, prints `$PATH` wrapped in a random sentinel (so any profile chatter is
/// trivially stripped), and is bounded by a 3s timeout + kill so a slow/hung profile
/// can't wedge startup. Returns `None` on any failure (caller falls back to the
/// current PATH + the floor dirs).
#[cfg(not(windows))]
fn login_shell_path() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const SENTINEL: &str = "__nc_path_8f3a2b__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let script = format!("printf '{SENTINEL}%s{SENTINEL}' \"$PATH\"");
    let mut child = Command::new(&shell)
        .args(["-lic", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > Duration::from_secs(3) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    extract_sentinel(&out, SENTINEL)
}

/// The well-known per-user tool dirs a launchd PATH lacks, filtered to those that
/// exist on disk. Used as a floor so even a missing/odd shell profile still resolves
/// bun/cargo/Homebrew.
#[cfg(not(windows))]
fn floor_dirs() -> Vec<String> {
    let mut dirs: Vec<String> = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]
        .iter()
        .filter(|d| std::path::Path::new(d).is_dir())
        .map(|d| (*d).to_string())
        .collect();
    if let Ok(home) = std::env::var("HOME") {
        for sub in [".bun/bin", ".cargo/bin", ".local/bin"] {
            let dir = format!("{home}/{sub}");
            if std::path::Path::new(&dir).is_dir() {
                dirs.push(dir);
            }
        }
    }
    dirs
}

/// Pure: append `extra` dirs to `base`'s `:`-separated PATH entries, preserving order
/// and skipping any already present. Unit-testable without touching the environment.
#[cfg(not(windows))]
fn merge_paths(base: &str, extra: &[String]) -> String {
    let mut parts: Vec<String> = base.split(':').filter(|s| !s.is_empty()).map(str::to_string).collect();
    for dir in extra {
        if !parts.iter().any(|p| p == dir) {
            parts.push(dir.clone());
        }
    }
    parts.join(":")
}

/// Pure: extract the value framed by the two sentinels in `output`, ignoring any
/// surrounding profile chatter. `None` when the sentinels are absent or the value is
/// blank. Unit-testable.
#[cfg(not(windows))]
fn extract_sentinel(output: &str, sentinel: &str) -> Option<String> {
    let start = output.find(sentinel)? + sentinel.len();
    let rest = &output[start..];
    let end = rest.find(sentinel)?;
    let value = rest[..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(windows))]
    fn merge_paths_appends_missing_dirs_in_order_and_dedupes() {
        let merged = merge_paths(
            "/usr/bin:/bin",
            &[
                "/opt/homebrew/bin".to_string(),
                "/usr/bin".to_string(), // already present — skipped
                "/Users/x/.cargo/bin".to_string(),
            ],
        );
        assert_eq!(merged, "/usr/bin:/bin:/opt/homebrew/bin:/Users/x/.cargo/bin");
    }

    #[test]
    #[cfg(not(windows))]
    fn merge_paths_handles_empty_base() {
        assert_eq!(merge_paths("", &["/opt/homebrew/bin".to_string()]), "/opt/homebrew/bin");
    }

    #[test]
    #[cfg(not(windows))]
    fn extract_sentinel_pulls_path_from_profile_chatter() {
        // A real `.zshrc` may print things before/after; the sentinel must still
        // isolate exactly the PATH value.
        let out = "welcome!\n__S__/usr/bin:/Users/x/.bun/bin__S__\nnvm loaded";
        assert_eq!(
            extract_sentinel(out, "__S__").as_deref(),
            Some("/usr/bin:/Users/x/.bun/bin")
        );
        // Absent sentinels or a blank value → None (caller falls back).
        assert!(extract_sentinel("no markers here", "__S__").is_none());
        assert!(extract_sentinel("__S__   __S__", "__S__").is_none());
    }

    /// Regression test for the Windows bun spawn bug: `Command::new("bun")` fails
    /// with `NotFound` on Windows because only `bun.cmd`/`bun.ps1` shims are on
    /// PATH, not a launchable `bun.exe`. The resolver must return a program that
    /// `CreateProcess` can actually spawn.
    #[test]
    #[cfg(windows)]
    fn bun_resolves_to_a_launchable_binary_on_windows() {
        let resolved = resolve_program("bun");
        assert!(
            std::process::Command::new(&resolved.program)
                .args(&resolved.prefix_args)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .is_ok(),
            "resolved bun program must be spawnable via CreateProcess: {resolved:?}"
        );
    }

    /// Cross-platform smoke test: `resolve_program("bun")` (via the bun alias) must
    /// return a non-empty program path (bun is a build prerequisite on all CI
    /// hosts).
    #[test]
    fn bun_resolver_returns_a_program() {
        let resolved = resolve_bun_program();
        assert!(
            !resolved.program.as_os_str().is_empty(),
            "resolve_bun_program must return a non-empty program"
        );
    }

    /// The generalized resolver produces the launchable-program shape for any name:
    /// when `which` can't find a tool on a non-Windows host, it falls back to the
    /// bare name with no prefix args (so the OS error surfaces at spawn). The shape
    /// — non-empty program, prefix args only present for a shell-routed fallback —
    /// must hold regardless of the name passed.
    #[test]
    fn resolve_program_returns_a_launchable_shape_for_npm() {
        let resolved = resolve_program("npm");
        assert!(
            !resolved.program.as_os_str().is_empty(),
            "resolve_program must return a non-empty program for any name"
        );
        // On non-Windows a missing tool resolves to the bare name with no prefix
        // args; a found tool resolves to an absolute path, also with no prefix args.
        // Prefix args only appear on the Windows shell-routed fallback.
        #[cfg(not(windows))]
        assert!(
            resolved.prefix_args.is_empty(),
            "non-Windows resolution never needs prefix args: {resolved:?}"
        );
    }

    /// `std_command` must pre-apply the resolved program so callers only add their
    /// own args; its program must match what `resolve_program` returns for the name.
    #[test]
    fn std_command_prebuilds_the_resolved_program() {
        let resolved = resolve_program("git");
        let cmd = std_command("git");
        assert_eq!(cmd.get_program(), resolved.program.as_os_str());
    }
}
