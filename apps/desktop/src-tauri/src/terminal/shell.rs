//! Platform-aware shell resolution + interactive-launch flags for the integrated
//! user terminal.
//!
//! The spawn used to hardcode `$SHELL` with a `/bin/zsh` fallback — meaningless on
//! Windows, so opening a terminal on Windows 11 failed with
//! `shell /bin/zsh does not exist`. Resolution is now platform-aware and,
//! crucially, PURE + INJECTABLE: [`resolve_shell_from`] takes the ordered candidate
//! list plus the env / existence / PATH probes as closures, so BOTH the Unix and the
//! Windows chains are unit-testable on any host (CI is Linux; a Windows box is never
//! in the loop). The platform difference is DATA (a candidate list), not `#[cfg]`
//! control flow — otherwise the off-host chain would compile out and be untestable.
//!
//! Resolution order:
//!  - every platform first honors `$SHELL` when it is set AND names an existing file;
//!  - Unix then tries `/bin/zsh` → `/bin/bash` → `/bin/sh` (first that exists);
//!  - Windows tries `pwsh.exe` (PATH) → `powershell.exe` (PATH) → `%COMSPEC%`
//!    (set + exists) → `cmd.exe` (PATH), using the `which`-style PATH lookup the
//!    editor launcher (`infra/editor.rs`) already relies on.
//!
//! Interactive flags are shell-family aware ([`interactive_args`]): only known
//! POSIX shells get `-i`; PowerShell / pwsh get `-NoLogo`; cmd.exe (and any
//! unrecognized program) gets nothing — never hand a POSIX flag to a shell that
//! would choke on it.

use std::path::Path;

/// One ordered shell candidate. The kind decides how it is probed; the pure
/// resolver ([`resolve_shell_from`]) walks a slice of these with injected probes,
/// so the platform lists are plain DATA and both chains are testable on any host.
///
/// CI is Linux with `clippy -D warnings`: the Windows-only [`ShellCandidate::OnPath`]
/// and the Unix-only [`ShellCandidate::Absolute`] variants are each constructed on
/// only ONE platform's lib build, so the OTHER platform flags them "never
/// constructed" (the PR #108 trap). `cfg_attr` silences that exactly where it bites
/// — the cross-platform tests below construct every variant, so the test build is
/// unaffected either way.
enum ShellCandidate {
    /// An absolute shell path — accepted iff it names an existing file. The Unix
    /// fallbacks (`/bin/zsh`, …).
    #[cfg_attr(windows, allow(dead_code))]
    Absolute(&'static str),
    /// An env var whose value (when set + non-empty) is an absolute path — accepted
    /// iff it exists. `$SHELL` on every platform; `%COMSPEC%` on Windows.
    FromEnv(&'static str),
    /// A bare command resolved on PATH via `which` — accepted iff it resolves, and
    /// the resolved absolute path is what gets launched. The Windows fallbacks
    /// (`pwsh.exe`, `powershell.exe`, `cmd.exe`).
    #[cfg_attr(not(windows), allow(dead_code))]
    OnPath(&'static str),
}

/// The Unix shell chain: `$SHELL` (if it exists) → zsh → bash → sh.
#[cfg(unix)]
const PLATFORM_SHELLS: &[ShellCandidate] = &[
    ShellCandidate::FromEnv("SHELL"),
    ShellCandidate::Absolute("/bin/zsh"),
    ShellCandidate::Absolute("/bin/bash"),
    ShellCandidate::Absolute("/bin/sh"),
];

/// The Windows shell chain: `$SHELL` (if it exists) → pwsh → powershell →
/// `%COMSPEC%` → cmd.
#[cfg(windows)]
const PLATFORM_SHELLS: &[ShellCandidate] = &[
    ShellCandidate::FromEnv("SHELL"),
    ShellCandidate::OnPath("pwsh.exe"),
    ShellCandidate::OnPath("powershell.exe"),
    ShellCandidate::FromEnv("COMSPEC"),
    ShellCandidate::OnPath("cmd.exe"),
];

/// Resolve the shell to launch, platform-aware + existence-validated. Errors —
/// naming every candidate tried, not a single bare path — when nothing resolves.
///
/// The resolver only ever returns a shell that exists, which also satisfies the
/// wezterm#7893 pre-validation the spawn needs (a bad program path aborts the child
/// AFTER `spawn` returns `Ok`), so a missing shell surfaces as this named error
/// rather than a mystery immediate exit.
pub(crate) fn resolve_shell() -> Result<String, String> {
    resolve_shell_from(
        PLATFORM_SHELLS,
        |var| std::env::var(var).ok(),
        |path| Path::new(path).is_file(),
        |cmd| {
            which::which(cmd)
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        },
    )
}

/// Resolve the first usable shell from `candidates`, using injected probes so the
/// logic is testable on any host:
///  - `env(name)` → the value of an environment variable (`None` when unset);
///  - `exists(path)` → whether an absolute path names an existing file;
///  - `on_path(cmd)` → the absolute path `cmd` resolves to on PATH (`which`), if any.
///
/// Returns the resolved shell program, or an error naming every candidate tried.
fn resolve_shell_from(
    candidates: &[ShellCandidate],
    env: impl Fn(&str) -> Option<String>,
    exists: impl Fn(&str) -> bool,
    on_path: impl Fn(&str) -> Option<String>,
) -> Result<String, String> {
    let mut tried: Vec<String> = Vec::new();
    for candidate in candidates {
        match candidate {
            ShellCandidate::Absolute(path) => {
                tried.push((*path).to_string());
                if exists(path) {
                    return Ok((*path).to_string());
                }
            }
            ShellCandidate::FromEnv(var) => {
                match env(var)
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                {
                    Some(value) => {
                        tried.push(format!("${var} ({value})"));
                        if exists(&value) {
                            return Ok(value);
                        }
                    }
                    None => tried.push(format!("${var} (unset)")),
                }
            }
            ShellCandidate::OnPath(cmd) => {
                tried.push(format!("{cmd} (PATH)"));
                if let Some(resolved) = on_path(cmd) {
                    return Ok(resolved);
                }
            }
        }
    }
    Err(format!(
        "could not resolve a shell to launch — tried {}. Set $SHELL to a valid shell.",
        tried.join(", ")
    ))
}

/// The interactive-launch args for `shell`, by shell family (pure, unit-tested per
/// shell). POSIX shells get `-i` (interactive — sources rc files for prompt/aliases
/// without a full login profile); PowerShell / pwsh get `-NoLogo`; cmd.exe (and any
/// unrecognized program) gets nothing. Never pass a POSIX flag to a non-POSIX shell.
pub(crate) fn interactive_args(shell: &str) -> Vec<&'static str> {
    match shell_stem(shell).as_str() {
        "pwsh" | "powershell" => vec!["-NoLogo"],
        stem if is_posix_shell(stem) => vec!["-i"],
        // cmd.exe and anything unrecognized: launch bare (no POSIX assumption).
        _ => vec![],
    }
}

/// The lower-cased file stem of a shell path, host-independently: splits on BOTH
/// `/` and `\` and drops a single trailing extension, so a Windows `C:\…\pwsh.exe`
/// classifies correctly even when this runs on a Unix host under test (where
/// `std::path::Path` would treat the whole `\`-string as one component).
fn shell_stem(shell: &str) -> String {
    let base = shell.rsplit(['/', '\\']).next().unwrap_or(shell);
    let stem = base.rsplit_once('.').map_or(base, |(name, _ext)| name);
    stem.to_ascii_lowercase()
}

/// Whether `stem` (a lower-cased shell file stem) is a known POSIX interactive
/// shell that understands `-i`.
fn is_posix_shell(stem: &str) -> bool {
    matches!(
        stem,
        "sh" | "bash" | "zsh" | "dash" | "ksh" | "mksh" | "ash" | "fish" | "tcsh" | "csh"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    // Literal candidate lists mirroring the real platform chains, so BOTH are
    // exercised on any host — the whole point of the injectable resolver (CI is
    // Linux, and a Windows box is never in the loop).
    const UNIX: &[ShellCandidate] = &[
        ShellCandidate::FromEnv("SHELL"),
        ShellCandidate::Absolute("/bin/zsh"),
        ShellCandidate::Absolute("/bin/bash"),
        ShellCandidate::Absolute("/bin/sh"),
    ];
    const WINDOWS: &[ShellCandidate] = &[
        ShellCandidate::FromEnv("SHELL"),
        ShellCandidate::OnPath("pwsh.exe"),
        ShellCandidate::OnPath("powershell.exe"),
        ShellCandidate::FromEnv("COMSPEC"),
        ShellCandidate::OnPath("cmd.exe"),
    ];

    /// Drive `resolve_shell_from` with fixture env / existing-files / PATH maps.
    fn resolve(
        candidates: &[ShellCandidate],
        env: &[(&str, &str)],
        files: &[&str],
        path: &[(&str, &str)],
    ) -> Result<String, String> {
        let env: HashMap<&str, &str> = env.iter().copied().collect();
        let files: HashSet<&str> = files.iter().copied().collect();
        let path: HashMap<&str, &str> = path.iter().copied().collect();
        resolve_shell_from(
            candidates,
            |k| env.get(k).map(|v| (*v).to_string()),
            |p| files.contains(p),
            |c| path.get(c).map(|v| (*v).to_string()),
        )
    }

    #[test]
    fn honors_shell_env_when_it_exists_on_every_platform() {
        // $SHELL wins over the fallbacks on unix...
        let got = resolve(
            UNIX,
            &[("SHELL", "/usr/bin/fish")],
            &["/usr/bin/fish", "/bin/zsh"],
            &[],
        );
        assert_eq!(got.unwrap(), "/usr/bin/fish");
        // ...and on windows (an existing $SHELL beats pwsh-on-PATH).
        let got = resolve(
            WINDOWS,
            &[("SHELL", "C:\\msys64\\usr\\bin\\bash.exe")],
            &["C:\\msys64\\usr\\bin\\bash.exe"],
            &[("pwsh.exe", "C:\\pwsh.exe")],
        );
        assert_eq!(got.unwrap(), "C:\\msys64\\usr\\bin\\bash.exe");
    }

    #[test]
    fn ignores_shell_env_that_does_not_exist_and_falls_through() {
        // $SHELL set but missing on disk → skip to the first existing fallback.
        let got = resolve(
            UNIX,
            &[("SHELL", "/bin/nope")],
            &["/bin/bash", "/bin/sh"],
            &[],
        );
        assert_eq!(
            got.unwrap(),
            "/bin/bash",
            "first existing unix fallback wins"
        );
    }

    #[test]
    fn unix_walks_zsh_then_bash_then_sh() {
        assert_eq!(resolve(UNIX, &[], &["/bin/sh"], &[]).unwrap(), "/bin/sh");
        assert_eq!(
            resolve(UNIX, &[], &["/bin/bash", "/bin/sh"], &[]).unwrap(),
            "/bin/bash",
            "bash is preferred over sh"
        );
    }

    #[test]
    fn windows_prefers_pwsh_then_powershell_then_comspec_then_cmd() {
        // pwsh on PATH wins.
        assert_eq!(
            resolve(
                WINDOWS,
                &[],
                &[],
                &[
                    ("pwsh.exe", "C:\\pwsh.exe"),
                    ("cmd.exe", "C:\\Windows\\System32\\cmd.exe"),
                ],
            )
            .unwrap(),
            "C:\\pwsh.exe"
        );
        // No pwsh; powershell on PATH is the next fallback.
        assert_eq!(
            resolve(
                WINDOWS,
                &[],
                &[],
                &[("powershell.exe", "C:\\WPS\\powershell.exe")]
            )
            .unwrap(),
            "C:\\WPS\\powershell.exe"
        );
        // No pwsh/powershell; %COMSPEC% (set + exists) beats cmd-on-PATH.
        let comspec = "C:\\Windows\\System32\\cmd.exe";
        assert_eq!(
            resolve(
                WINDOWS,
                &[("COMSPEC", comspec)],
                &[comspec],
                &[("cmd.exe", "C:\\other\\cmd.exe")],
            )
            .unwrap(),
            comspec,
            "%COMSPEC% is used verbatim before the PATH cmd.exe"
        );
        // Nothing but cmd on PATH.
        assert_eq!(
            resolve(
                WINDOWS,
                &[],
                &[],
                &[("cmd.exe", "C:\\Windows\\System32\\cmd.exe")]
            )
            .unwrap(),
            "C:\\Windows\\System32\\cmd.exe"
        );
    }

    #[test]
    fn error_names_every_candidate_tried_not_one_path() {
        // Nothing resolves anywhere → the error lists what was attempted.
        let err = resolve(WINDOWS, &[], &[], &[]).unwrap_err();
        assert!(err.contains("pwsh.exe"), "names pwsh: {err}");
        assert!(err.contains("powershell.exe"), "names powershell: {err}");
        assert!(err.contains("cmd.exe"), "names cmd: {err}");
        assert!(err.contains("SHELL"), "names $SHELL: {err}");
        assert!(err.contains("COMSPEC"), "names %COMSPEC%: {err}");

        let err = resolve(UNIX, &[], &[], &[]).unwrap_err();
        assert!(
            err.contains("/bin/zsh") && err.contains("/bin/bash") && err.contains("/bin/sh"),
            "the unix error names all three fallbacks: {err}"
        );
    }

    #[test]
    fn interactive_args_are_shell_family_aware() {
        assert_eq!(interactive_args("/bin/zsh"), vec!["-i"]);
        assert_eq!(interactive_args("/bin/bash"), vec!["-i"]);
        assert_eq!(interactive_args("/usr/bin/fish"), vec!["-i"]);
        assert_eq!(
            interactive_args("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
            vec!["-NoLogo"]
        );
        assert_eq!(
            interactive_args("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
            vec!["-NoLogo"]
        );
        assert!(
            interactive_args("C:\\Windows\\System32\\cmd.exe").is_empty(),
            "cmd.exe gets no args"
        );
        assert!(
            interactive_args("C:\\tools\\mystery.exe").is_empty(),
            "an unrecognized program never gets a POSIX flag"
        );
    }

    #[test]
    fn shell_stem_is_host_independent() {
        assert_eq!(shell_stem("/bin/zsh"), "zsh");
        assert_eq!(shell_stem("C:\\Windows\\System32\\cmd.exe"), "cmd");
        assert_eq!(
            shell_stem("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
            "pwsh"
        );
        assert_eq!(shell_stem("PowerShell.EXE"), "powershell", "case-folded");
    }

    #[test]
    fn real_resolve_shell_finds_a_shell_on_the_test_host() {
        // The non-injected wrapper resolves SOMETHING on the CI host (every unix box
        // has /bin/sh). This also compiles the platform const under `cargo check`.
        assert!(resolve_shell().is_ok(), "a shell resolves on the test host");
    }
}
