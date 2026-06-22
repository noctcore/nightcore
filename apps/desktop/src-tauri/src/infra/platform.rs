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
//! spawn (`m2/provider.rs`, async tokio), the readiness gauntlet's `bun`/`npm`/`cargo`
//! steps (`gauntlet.rs`), and the `git` calls in `m2/worktree.rs` + `project.rs`.

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

#[cfg(test)]
mod tests {
    use super::*;

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
