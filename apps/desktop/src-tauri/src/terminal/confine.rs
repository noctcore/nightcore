//! OPT-IN macOS write-containment for a CONFINED user terminal (decision 1).
//!
//! Mirrors the engine's Seatbelt write-sandbox (`providers/claude/sandbox.ts`) but
//! for a Rust-spawned shell: a `(allow default)` + `(deny file-write*)` profile
//! with `file-write*` re-allowed only under the session cwd (plus the git common
//! dir for a worktree cwd, `/dev`, the temp trees, and the Claude Code per-session
//! STATE dirs under `~/.claude` — see [`claude_state_write_roots`] — so an ordinary
//! shell AND an in-terminal `claude` still work). Reads and network stay open — this
//! contains WRITES to the workspace, it does not air-gap.
//!
//! **FAIL CLOSED** — unlike the engine's fail-OPEN sandbox (an experimental,
//! default-off agent feature that must never strand a task), a user who explicitly
//! ticked "Confined" is asking for containment: if the profile can't be assembled
//! (not macOS, no `sandbox-exec`, cwd won't canonicalize, scratch write fails) we
//! REFUSE the spawn with an error rather than silently launching an unconfined
//! shell. The default terminal is unconfined; confinement is the deliberate ask.
//!
//! The profile string builder and the git-common-dir parser are PURE (no macOS,
//! no I/O beyond the `.git` read) so they unit-test on any host; only [`prepare`]
//! touches Seatbelt and the filesystem, and is macOS-only.

use std::path::{Path, PathBuf};

/// The Seatbelt interpreter — an absolute, SIP-protected path, never resolved via
/// PATH (so a malicious `sandbox-exec` shim can't intercept the wrap).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// What [`prepare`] hands back: the program + prefix args to launch INSTEAD of the
/// bare shell. The caller appends the shell + its args, so the final argv is
/// `sandbox-exec -f <profile> <shell> -i`.
#[derive(Debug, Clone)]
pub(crate) struct ConfinedLaunch {
    pub(crate) program: PathBuf,
    pub(crate) prefix_args: Vec<String>,
    /// Env vars the caller sets on the PTY command so zsh/oh-my-zsh housekeeping
    /// writes (history, completion dump, framework cache) land in the writable temp
    /// state dir instead of $HOME, which the profile denies. See [`shell_state_env`].
    pub(crate) env: Vec<(String, String)>,
}

/// Escape a path for a Seatbelt TinyScheme double-quoted string literal.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn seatbelt_string(p: &str) -> String {
    format!("\"{}\"", p.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Build a deny-write-except profile: everything allowed except `file-write*`,
/// re-allowed only under each root (`subpath` — the root and everything beneath).
/// Pure — no I/O — so it is unit-testable off a macOS host. Callers must pass
/// CANONICALIZED roots (Seatbelt matches the kernel-resolved, symlink-free path).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn build_profile(writable_roots: &[String]) -> String {
    let mut lines = vec![
        "(version 1)".to_string(),
        "(allow default)".to_string(),
        "(deny file-write*)".to_string(),
    ];
    for root in writable_roots {
        lines.push(format!(
            "(allow file-write* (subpath {}))",
            seatbelt_string(root)
        ));
    }
    lines.join("\n") + "\n"
}

/// When `cwd` is a LINKED git worktree, its `.git` is a FILE containing
/// `gitdir: <abs>/.git/worktrees/<name>`; git writes index/locks/objects/refs to
/// that common dir even for worktree-local ops, so containment must allow the whole
/// `<repo>/.git` or every `git` command in the terminal fails. Returns `None` for a
/// normal checkout (its `.git` is a dir under cwd) or a non-repo cwd. The parent
/// WORKING TREE is deliberately NOT allowed. Pure but for the `.git` file read.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn git_common_write_root(cwd: &Path) -> Option<PathBuf> {
    let dot_git = cwd.join(".git");
    if !dot_git.is_file() {
        return None; // a normal checkout's `.git` is a directory, already under cwd
    }
    let content = std::fs::read_to_string(&dot_git).ok()?;
    let gitdir_line = content
        .lines()
        .find_map(|l| l.strip_prefix("gitdir:"))?
        .trim();
    let gitdir = cwd.join(gitdir_line);
    // `<repo>/.git/worktrees/<name>` → allow `<repo>/.git`. Any other layout: allow
    // the pointed-to dir itself.
    let worktrees_dir = gitdir.parent()?;
    let common = if worktrees_dir.file_name().is_some_and(|n| n == "worktrees") {
        worktrees_dir.parent()?.to_path_buf()
    } else {
        gitdir
    };
    Some(common)
}

/// The Claude Code per-session STATE subdirectories under the user's `~/.claude`
/// that a confined `claude` must be able to WRITE (verified against the shipped CLI):
/// the user's SessionStart hook does `mkdir ~/.claude/session-env/<uuid>`, and the
/// TUI writes transcripts, todos, shell snapshots, telemetry, and logs. Each becomes
/// its own `subpath` carve-out, so writes land ONLY inside these leaves.
///
/// SECURITY — the `~/.claude` ROOT is DELIBERATELY ABSENT here, and so is everything
/// else under it (`settings.json`, `hooks/`, `skills/`, `agents/`, `commands/`,
/// `plugins/`, `CLAUDE.md`). Those are CONFIG, and a confined shell that could rewrite
/// them would ESCAPE the sandbox: Claude Code hooks execute OUTSIDE the Seatbelt
/// profile, so a writable `settings.json` / `hooks/` is arbitrary code execution as
/// the user. Only ephemeral per-session STATE is writable; config stays read-only.
/// (Grilled + locked 2026-07-11 — do not add the root or any config path here.)
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const CLAUDE_STATE_DIRS: [&str; 7] = [
    "session-env",
    "projects",
    "todos",
    "shell-snapshots",
    "statsig",
    "logs",
    "debug",
];

/// The writable Seatbelt roots for a confined session's Claude state: each
/// [`CLAUDE_STATE_DIRS`] leaf under `<home>/.claude`, canonicalized where it already
/// exists (else the lexical path, so a not-yet-created `session-env` still gets a
/// rule — the SessionStart `mkdir` needs the carve-out to exist BEFORE the dir does).
/// The `.claude` ROOT itself is NEVER returned (config-write = sandbox escape via
/// hooks — see [`CLAUDE_STATE_DIRS`]). Pure — pass a resolved home. Callers must have
/// already canonicalized `home` so a non-existent leaf's lexical path still matches
/// the kernel-resolved path Seatbelt sees.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn claude_state_write_roots(home: &Path) -> Vec<String> {
    let claude_dir = home.join(".claude");
    CLAUDE_STATE_DIRS
        .iter()
        .map(|leaf| realpath_or(&claude_dir.join(leaf)))
        .collect()
}

/// `canonicalize` that degrades to the lexical absolute path when the target can't
/// be resolved — a not-yet-created optional root still gets a rule.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn realpath_or(p: &Path) -> String {
    std::fs::canonicalize(p)
        .unwrap_or_else(|_| p.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// The shell-state env redirect for a confined session: point zsh's history +
/// completion dump and the XDG cache root (which oh-my-zsh honours) at `state_dir`,
/// a subdir of the already-writable temp scratch tree, so first-run housekeeping
/// doesn't spam `Operation not permitted` denials trying to write $HOME
/// (`~/.zsh_history`, `~/.zcompdump`, `~/.cache/oh-my-zsh`) — which the profile
/// denies. BEST-EFFORT: a shell/framework that ignores these vars still just prints
/// the denials; we deliberately do NOT widen the profile with $HOME allowances to
/// silence them. Pure — the caller pre-creates the dirs.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn shell_state_env(state_dir: &Path) -> Vec<(String, String)> {
    let at = |leaf: &str| state_dir.join(leaf).to_string_lossy().into_owned();
    vec![
        ("HISTFILE".to_string(), at("zsh_history")),
        ("XDG_CACHE_HOME".to_string(), at("cache")),
        ("ZSH_COMPDUMP".to_string(), at("zcompdump")),
    ]
}

/// The user's canonicalized home directory (`HOME` on macOS), or `None` when it is
/// unset/empty. Canonicalized so the `~/.claude/<state-dir>` carve-outs match the
/// kernel-resolved path Seatbelt sees even if `HOME` carries a symlink component.
#[cfg(target_os = "macos")]
fn confined_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .map(|h| std::fs::canonicalize(&h).unwrap_or(h))
}

/// The writable roots for one confined session: the (canonicalized) cwd, the git
/// common dir for a worktree cwd, `/dev`, the darwin temp trees, and the Claude Code
/// per-session state dirs under `~/.claude` (never the `.claude` root). Deduped,
/// order-stable. Returns an error only if the cwd itself can't be canonicalized
/// (fail-closed: a session with no writable cwd is useless and the ask was for
/// containment).
#[cfg(target_os = "macos")]
fn derive_writable_roots(cwd: &Path) -> Result<Vec<String>, String> {
    let mut roots = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut add = |p: String| {
        if seen.insert(p.clone()) {
            roots.push(p);
        }
    };

    let canon_cwd = std::fs::canonicalize(cwd).map_err(|e| {
        format!(
            "confined terminal: cwd {} cannot be resolved: {e}",
            cwd.display()
        )
    })?;
    add(canon_cwd.to_string_lossy().into_owned());
    if let Some(git_common) = git_common_write_root(cwd) {
        add(realpath_or(&git_common));
    }
    add("/dev".to_string());
    add(realpath_or(&std::env::temp_dir()));
    add("/private/tmp".to_string());
    add("/private/var/folders".to_string());
    // Claude Code per-session STATE dirs under ~/.claude, so an in-terminal `claude`
    // (and the user's SessionStart hook's `mkdir ~/.claude/session-env/<uuid>`) can
    // write instead of EPERM-ing. The `.claude` ROOT + config stay denied — see
    // `claude_state_write_roots`. When HOME is unset the carve-outs are simply omitted
    // (an in-terminal `claude` then can't run, but the confined shell still works).
    if let Some(home) = confined_home_dir() {
        for root in claude_state_write_roots(&home) {
            add(root);
        }
    }
    Ok(roots)
}

/// Assemble the confinement wrapper for a shell about to run in `cwd`. FAIL CLOSED:
/// any failure returns an error and the caller must NOT spawn unconfined.
#[cfg(target_os = "macos")]
pub(crate) fn prepare(cwd: &Path) -> Result<ConfinedLaunch, String> {
    if !Path::new(SANDBOX_EXEC).exists() {
        return Err(format!(
            "confined terminal unavailable: {SANDBOX_EXEC} is missing on this host"
        ));
    }
    let roots = derive_writable_roots(cwd)?;
    let profile = build_profile(&roots);

    // A per-session scratch dir under the temp tree (which is itself a writable
    // root — the profile is read once at exec, so a running session can't rewrite
    // its own containment). Unique via pid + nanos, matching `store::atomic`.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let scratch = std::env::temp_dir().join(format!(
        "nightcore-term-sandbox-{}-{nonce}",
        std::process::id()
    ));
    std::fs::create_dir_all(&scratch)
        .map_err(|e| format!("confined terminal: cannot create sandbox scratch dir: {e}"))?;
    let profile_path = scratch.join("write-containment.sb");
    std::fs::write(&profile_path, profile)
        .map_err(|e| format!("confined terminal: cannot write Seatbelt profile: {e}"))?;

    // Redirect shell housekeeping (history / completion dump / framework cache) into
    // a per-session state dir under the scratch tree — a writable root — instead of
    // $HOME, which the profile denies. Pre-create it (plus the `cache` subdir) so the
    // shell finds the paths. `create_dir_all` on the `cache` leaf makes both.
    // LIFECYCLE: like the profile file above, this lives under the OS temp tree and is
    // left for the temp cleaner to reap — the session never records the scratch path,
    // so there is no cheap kill/reap hook to delete it from, and confined sessions are
    // rare + tiny (a history file + compdump).
    let state_dir = scratch.join("state");
    std::fs::create_dir_all(state_dir.join("cache"))
        .map_err(|e| format!("confined terminal: cannot create shell state dir: {e}"))?;

    Ok(ConfinedLaunch {
        program: PathBuf::from(SANDBOX_EXEC),
        prefix_args: vec![
            "-f".to_string(),
            profile_path.to_string_lossy().into_owned(),
        ],
        env: shell_state_env(&state_dir),
    })
}

/// Non-macOS: confinement is a macOS-only Seatbelt feature. Fail closed.
#[cfg(not(target_os = "macos"))]
pub(crate) fn prepare(_cwd: &Path) -> Result<ConfinedLaunch, String> {
    Err("confined terminals require macOS Seatbelt (sandbox-exec)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn profile_denies_writes_then_allows_each_root() {
        let profile = build_profile(&["/work/dir".to_string(), "/private/tmp".to_string()]);
        assert!(profile.contains("(deny file-write*)"));
        assert!(profile.contains("(allow file-write* (subpath \"/work/dir\"))"));
        assert!(profile.contains("(allow file-write* (subpath \"/private/tmp\"))"));
        // The deny must precede the allows (first the blanket deny, then carve-outs).
        let deny = profile.find("(deny file-write*)").unwrap();
        let allow = profile.find("(allow file-write* (subpath").unwrap();
        assert!(
            deny < allow,
            "the blanket deny comes before the allow carve-outs"
        );
    }

    #[test]
    fn seatbelt_string_escapes_quotes_and_backslashes() {
        assert_eq!(seatbelt_string(r#"/a "b"\c"#), r#""/a \"b\"\\c""#);
    }

    #[test]
    fn shell_state_env_points_every_var_under_the_state_dir() {
        // The redirect vars must all live DIRECTLY under the given state dir with the
        // expected leaf names, so confined housekeeping never touches $HOME.
        let state = Path::new("/tmp/nc-state");
        let env = shell_state_env(state);
        assert_eq!(env.len(), 3);
        for (key, leaf) in [
            ("HISTFILE", "zsh_history"),
            ("XDG_CACHE_HOME", "cache"),
            ("ZSH_COMPDUMP", "zcompdump"),
        ] {
            let value = env
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| panic!("{key} is set"));
            let p = Path::new(&value);
            assert_eq!(
                p.parent().unwrap(),
                state,
                "{key} lives under the state dir"
            );
            assert_eq!(p.file_name().unwrap(), std::ffi::OsStr::new(leaf));
        }
    }

    #[test]
    fn claude_state_roots_allow_each_state_dir_but_never_the_claude_root() {
        let home = Path::new("/Users/tester");
        let roots = claude_state_write_roots(home);

        // Exactly the grilled state dirs, each a leaf UNDER ~/.claude.
        assert_eq!(roots.len(), CLAUDE_STATE_DIRS.len());
        for leaf in [
            "session-env",
            "projects",
            "todos",
            "shell-snapshots",
            "statsig",
            "logs",
            "debug",
        ] {
            let expected = format!("/Users/tester/.claude/{leaf}");
            assert!(
                roots.contains(&expected),
                "the {leaf} state dir must be a writable root"
            );
        }

        // SECURITY INVARIANT: the ~/.claude ROOT is NEVER a writable root — a confined
        // shell that could rewrite settings.json / hooks/ would escape (hooks run
        // outside the sandbox). Config-write must stay denied.
        assert!(
            !roots.iter().any(|r| r == "/Users/tester/.claude"),
            "the .claude root must not be writable"
        );
    }

    #[test]
    fn profile_carves_out_state_dirs_and_omits_the_claude_root_allow() {
        let profile = build_profile(&claude_state_write_roots(Path::new("/Users/tester")));
        // Each state dir is an explicit allow…
        assert!(
            profile.contains("(allow file-write* (subpath \"/Users/tester/.claude/session-env\"))")
        );
        assert!(profile.contains("(allow file-write* (subpath \"/Users/tester/.claude/todos\"))"));
        assert!(profile.contains("(allow file-write* (subpath \"/Users/tester/.claude/debug\"))"));
        // …but the `.claude` ROOT itself is NOT allowed (the closing-quote form only
        // matches an allow of the bare root, not the `/session-env`-suffixed carve-outs).
        assert!(
            !profile.contains("(allow file-write* (subpath \"/Users/tester/.claude\"))"),
            "the .claude root must never get a write-allow — config-write is the escape vector"
        );
    }

    #[test]
    fn git_common_root_is_none_for_a_normal_checkout() {
        // A `.git` DIRECTORY (normal checkout) yields no extra root — it's under cwd.
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir(tmp.path().join(".git")).unwrap();
        assert!(git_common_write_root(tmp.path()).is_none());
    }

    #[test]
    fn git_common_root_resolves_a_linked_worktree() {
        // A `.git` FILE with a `gitdir:` pointer (linked worktree) yields the repo's
        // `.git` common dir so `git` works inside the confined worktree terminal.
        let tmp = TempDir::new().unwrap();
        let repo_git = tmp.path().join("repo/.git");
        std::fs::create_dir_all(repo_git.join("worktrees/wt1")).unwrap();
        let wt = tmp.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", repo_git.join("worktrees/wt1").display()),
        )
        .unwrap();
        assert_eq!(git_common_write_root(&wt), Some(repo_git));
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn prepare_fails_closed_off_macos() {
        let err = prepare(Path::new("/tmp")).unwrap_err();
        assert!(
            err.contains("macOS"),
            "off-macOS confinement must refuse: {err}"
        );
    }
}
