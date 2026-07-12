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

/// The Codex CLI's per-session STATE subdirectories under `$CODEX_HOME` (else
/// `<home>/.codex`) that a confined `codex` must be able to WRITE (verified against
/// the shipped CLI: `state_N.sqlite` opens read-write at startup, and sessions,
/// history, logs, the MCP OAuth lock file, and the node REPL scratch tree all live
/// under these leaves). Each becomes its own `subpath` carve-out via
/// [`codex_state_write_roots`], mirroring [`CLAUDE_STATE_DIRS`].
///
/// SECURITY — the `.codex` ROOT is DELIBERATELY ABSENT here, and so is everything
/// else under it (`config.toml`, `auth.json`, `plugins/`, `computer-use/`, `agents/`,
/// `skills/`, `rules/`, `AGENTS.md`, `vendor_imports/`). Those are CONFIG /
/// CREDENTIAL / EXECUTABLE surfaces, and a confined shell that could rewrite them
/// would ESCAPE the sandbox: `config.toml` defines a `notify` exec program and MCP
/// server commands, `plugins/` and `computer-use/` (an app bundle) are executable
/// code, and `agents/` / `skills/` / `rules/` / `AGENTS.md` are prompt-injection
/// surfaces a future UNCONFINED `codex` would read and act on. `auth.json` is OAuth
/// credentials — write access there is credential tamper, never just an escape. Only
/// ephemeral per-session STATE is writable; config/creds/exec stay read-only.
///
/// `memories/` (and the versioned `memories_N.sqlite` matched by
/// [`codex_versioned_db_regex_line`]) is a DELIBERATE, FLAGGED exception: memories are
/// re-read by codex as context, a softer prompt-injection-persistence vector than
/// executable config — but (a) codex opens `memories_1.sqlite` read-write at startup,
/// so denying it reintroduces the exact fatal "readonly database" crash this
/// carve-out exists to fix; (b) it is consistent with the existing precedent of
/// allowing `~/.claude/projects` (transcripts re-read on `--resume`); (c) codex still
/// gates command EXECUTION behind user approval, so a poisoned memory is not itself
/// arbitrary code (defense in depth). Tightening this later is trivial.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const CODEX_STATE_DIRS: [&str; 11] = [
    "sessions",
    "archived_sessions",
    "log",
    "cache",
    "shell_snapshots",
    "tmp",
    ".tmp",
    "sqlite",
    "node_repl",
    "mcp-oauth-locks",
    "memories",
];

/// Fixed root-level Codex STATE files (never config/creds) that get a `literal`
/// carve-out — see [`codex_state_file_lines`]. `history.jsonl` / `session_index.jsonl`
/// are the terminal command-history logs; `models_cache.json` / `version.json` /
/// `installation_id` are CLI-maintained caches/identifiers, not user config;
/// `.codex-global-state.json(.bak)` and `.personality_migration` are internal
/// migration/state bookkeeping the CLI writes at startup.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const CODEX_STATE_FILES: [&str; 8] = [
    "history.jsonl",
    "session_index.jsonl",
    "models_cache.json",
    "version.json",
    "installation_id",
    ".codex-global-state.json",
    ".codex-global-state.json.bak",
    ".personality_migration",
];

/// The writable Seatbelt roots for a confined session's Codex state: each
/// [`CODEX_STATE_DIRS`] leaf under `codex_home`, canonicalized where it already
/// exists (else the lexical path — mirrors [`claude_state_write_roots`]). The
/// `.codex` home ROOT itself is NEVER returned. Pure — pass an already-resolved
/// `codex_home` (see [`codex_home_dir`]).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn codex_state_write_roots(codex_home: &Path) -> Vec<String> {
    CODEX_STATE_DIRS
        .iter()
        .map(|leaf| realpath_or(&codex_home.join(leaf)))
        .collect()
}

/// Escape every character NOT in `[A-Za-z0-9_/-]` with a backslash so a codex home
/// path can be spliced verbatim into a Seatbelt `(regex #"…"#)` pattern without its
/// literal characters being read as regex metacharacters — most importantly the `.`
/// in `.codex` (and in any username containing a dot, e.g. `/Users/a.b/.codex`),
/// which left unescaped would match ANY character and silently widen the carve-out.
/// Pure string transform — no I/O.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn regex_escape_seatbelt(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '/' | '-') {
            out.push(c);
        } else {
            out.push('\\');
            out.push(c);
        }
    }
    out
}

/// The `(allow file-write* (literal …))` lines for each [`CODEX_STATE_FILES`] leaf
/// directly under `codex_home`, each via `realpath_or` so a not-yet-created file
/// still gets a rule. Pure — testable off macOS. Never emits `auth.json` or
/// `config.toml` — those are not in [`CODEX_STATE_FILES`].
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn codex_state_file_lines(codex_home: &Path) -> Vec<String> {
    CODEX_STATE_FILES
        .iter()
        .map(|leaf| {
            format!(
                "(allow file-write* (literal {}))",
                seatbelt_string(&realpath_or(&codex_home.join(leaf)))
            )
        })
        .collect()
}

/// The ONE `(allow file-write* (regex #"…"#))` line covering codex's
/// version-numbered SQLite state DBs + WAL/SHM/journal sidecars directly under
/// `codex_home` (`state_5.sqlite`, `goals_1.sqlite`, `memories_1.sqlite`, …). Codex
/// bumps the version integer across releases, so a literal list would silently
/// re-break after every codex update; a single anchored regex survives it. Anchored
/// `^<home>/[a-z_]+_[0-9]+\.sqlite(-wal|-shm|-journal)?$` with `codex_home` passed
/// through [`regex_escape_seatbelt`] — the `^…$` anchors plus the `[a-z_]+_[0-9]+`
/// filename class mean it matches ONLY a versioned DB filename directly under the
/// home, never `auth.json`, never `config.toml`, never `state_5.sqlite.bak` (no bare
/// dot-suffix alternation beyond the sidecars), never a nested `sessions/x_1.sqlite`
/// (no `/` inside the class). Pure — testable off macOS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn codex_versioned_db_regex_line(codex_home: &Path) -> String {
    let escaped = regex_escape_seatbelt(&codex_home.to_string_lossy());
    format!(
        "(allow file-write* (regex #\"^{escaped}/[a-z_]+_[0-9]+\\.sqlite(-wal|-shm|-journal)?$\"#))"
    )
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

/// The Codex CLI's canonicalized home directory: `$CODEX_HOME` (non-empty) else
/// `<home>/.codex`, where `<home>` is [`confined_home_dir`]. Mirrors
/// `usage::cost::codex_dirs` / `usage::credentials::codex_auth_file`. Canonicalized
/// so the state carve-outs match the kernel-resolved path Seatbelt sees; degrades to
/// the lexical path when the codex home doesn't exist yet (a first-run install must
/// still get its carve-outs BEFORE codex creates the dir — same discipline as
/// [`realpath_or`]). `None` when neither `$CODEX_HOME` nor `HOME` resolves — the
/// codex carve-outs are then simply omitted (the confined shell still works;
/// in-terminal `codex` just won't run, same as the Claude `HOME`-unset path).
#[cfg(target_os = "macos")]
fn codex_home_dir() -> Option<PathBuf> {
    let base = std::env::var_os("CODEX_HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .or_else(|| confined_home_dir().map(|h| h.join(".codex")))?;
    Some(std::fs::canonicalize(&base).unwrap_or(base))
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
    // Codex per-session STATE dirs under $CODEX_HOME (else ~/.codex) — same
    // discipline as the Claude carve-out above: only ephemeral STATE is writable;
    // the `.codex` root/config/credentials/exec surfaces stay denied (see
    // `CODEX_STATE_DIRS`). The root-level state FILES + the versioned-sqlite regex
    // are `literal`/`regex` allows, not `subpath` roots, so `prepare()` appends them
    // directly to the assembled profile string instead of folding them in here. When
    // neither $CODEX_HOME nor HOME resolves the carve-outs are simply omitted
    // (in-terminal `codex` then can't run, but the confined shell still works).
    if let Some(codex_home) = codex_home_dir() {
        for root in codex_state_write_roots(&codex_home) {
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
    let mut profile = build_profile(&roots);
    // Codex root-level state FILES + the versioned-sqlite DB regex are `literal`/
    // `regex` allows (not `subpath` roots), so they're appended directly to the
    // assembled profile string rather than folded into `derive_writable_roots`.
    if let Some(codex_home) = codex_home_dir() {
        for line in codex_state_file_lines(&codex_home) {
            profile.push_str(&line);
            profile.push('\n');
        }
        profile.push_str(&codex_versioned_db_regex_line(&codex_home));
        profile.push('\n');
    }

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
    fn codex_state_roots_allow_each_state_dir_but_never_config_creds_or_exec_paths() {
        let codex_home = Path::new("/Users/tester/.codex");
        let roots = codex_state_write_roots(codex_home);

        // Exactly the spec'd state dirs, each a leaf UNDER the codex home.
        assert_eq!(roots.len(), CODEX_STATE_DIRS.len());
        for leaf in [
            "sessions",
            "archived_sessions",
            "log",
            "cache",
            "shell_snapshots",
            "tmp",
            ".tmp",
            "sqlite",
            "node_repl",
            "mcp-oauth-locks",
            "memories",
        ] {
            let expected = format!("/Users/tester/.codex/{leaf}");
            assert!(
                roots.contains(&expected),
                "the {leaf} codex state dir must be a writable root"
            );
        }

        // SECURITY INVARIANT: the .codex ROOT and every CONFIG/CREDENTIAL/EXEC
        // surface under it are NEVER writable roots — a confined shell that could
        // rewrite them would escape the sandbox (config.toml execs a `notify`
        // program + MCP server commands; auth.json is OAuth credentials;
        // plugins/computer-use are executable; agents/skills/rules/AGENTS.md are
        // prompt-injection surfaces).
        for never in [
            "/Users/tester/.codex",
            "/Users/tester/.codex/config.toml",
            "/Users/tester/.codex/auth.json",
            "/Users/tester/.codex/plugins",
            "/Users/tester/.codex/computer-use",
            "/Users/tester/.codex/agents",
            "/Users/tester/.codex/skills",
            "/Users/tester/.codex/rules",
            "/Users/tester/.codex/AGENTS.md",
            "/Users/tester/.codex/vendor_imports",
        ] {
            assert!(
                !roots.iter().any(|r| r == never),
                "{never} must never be a writable root"
            );
        }
    }

    #[test]
    fn codex_state_file_lines_emit_each_fixed_file_but_never_auth_or_config() {
        let codex_home = Path::new("/Users/tester/.codex");
        let lines = codex_state_file_lines(codex_home);

        assert_eq!(lines.len(), CODEX_STATE_FILES.len());
        for leaf in [
            "history.jsonl",
            "session_index.jsonl",
            "models_cache.json",
            "version.json",
            "installation_id",
            ".codex-global-state.json",
            ".codex-global-state.json.bak",
            ".personality_migration",
        ] {
            let expected = format!("(allow file-write* (literal \"/Users/tester/.codex/{leaf}\"))");
            assert!(
                lines.contains(&expected),
                "the {leaf} state file must get a literal allow"
            );
        }

        // SECURITY INVARIANT: credentials + config are never fixed state files.
        assert!(!lines.iter().any(|l| l.contains("auth.json")));
        assert!(!lines.iter().any(|l| l.contains("config.toml")));
    }

    #[test]
    fn codex_versioned_db_regex_matches_versioned_dbs_and_sidecars_only() {
        let codex_home = Path::new("/Users/tester/.codex");
        let line = codex_versioned_db_regex_line(codex_home);

        let pattern = line
            .strip_prefix("(allow file-write* (regex #\"")
            .and_then(|s| s.strip_suffix("\"#))"))
            .expect("the regex line has the expected Seatbelt allow shape");
        let re = regex::Regex::new(pattern).expect("the emitted pattern is a valid regex");

        for matching in [
            "/Users/tester/.codex/state_5.sqlite",
            "/Users/tester/.codex/state_5.sqlite-wal",
            "/Users/tester/.codex/state_5.sqlite-shm",
            "/Users/tester/.codex/goals_1.sqlite",
            "/Users/tester/.codex/logs_2.sqlite",
            "/Users/tester/.codex/memories_1.sqlite",
        ] {
            assert!(re.is_match(matching), "{matching} must match the DB regex");
        }
        for non_matching in [
            "/Users/tester/.codex/auth.json",
            "/Users/tester/.codex/config.toml",
            "/Users/tester/.codex/state_5.sqlite.bak",
            "/Users/tester/.codex/sessions/x_1.sqlite",
        ] {
            assert!(
                !re.is_match(non_matching),
                "{non_matching} must NOT match the DB regex"
            );
        }
    }

    #[test]
    fn regex_escape_seatbelt_escapes_dots_and_spaces_but_not_slashes_or_word_chars() {
        let escaped = regex_escape_seatbelt("/Users/a.b/.codex home_dir-2");
        assert_eq!(escaped, r"/Users/a\.b/\.codex\ home_dir-2");
    }

    #[test]
    fn codex_lines_never_allow_the_config_root_or_any_denylisted_path() {
        let codex_home = Path::new("/Users/tester/.codex");
        let mut assembled = build_profile(&codex_state_write_roots(codex_home));
        for line in codex_state_file_lines(codex_home) {
            assembled.push_str(&line);
            assembled.push('\n');
        }
        assembled.push_str(&codex_versioned_db_regex_line(codex_home));
        assembled.push('\n');

        // The state carve-outs are present…
        assert!(
            assembled.contains("(allow file-write* (subpath \"/Users/tester/.codex/sessions\"))")
        );
        assert!(assembled
            .contains("(allow file-write* (literal \"/Users/tester/.codex/history.jsonl\"))"));
        assert!(assembled.contains("[a-z_]+_[0-9]+"));

        // …but no allow whose TARGET is the .codex root or a config/credential/exec
        // path. The root check requires the bare-root path to be immediately
        // quote-terminated, so it doesn't false-positive on a `/sessions`-suffixed
        // carve-out that merely starts with the same prefix.
        assert!(!assembled.contains("\"/Users/tester/.codex\""));
        for never in [
            "/Users/tester/.codex/config.toml",
            "/Users/tester/.codex/auth.json",
            "/Users/tester/.codex/plugins",
            "/Users/tester/.codex/computer-use",
            "/Users/tester/.codex/agents",
            "/Users/tester/.codex/skills",
            "/Users/tester/.codex/rules",
            "/Users/tester/.codex/AGENTS.md",
            "/Users/tester/.codex/vendor_imports",
        ] {
            assert!(
                !assembled.contains(never),
                "{never} must never appear as an allow target in the assembled profile"
            );
        }
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

    // --- macOS-only: the composed writable-set assembly in `derive_writable_roots`.
    // The pure helpers it composes are covered above; these pin how it wires cwd, the
    // worktree git-common dir, the ~/.claude state leaves, parent exclusion, and dedup.

    /// HOME is process-global; serialize the tests that pin it so a parallel run can't
    /// swap it mid-assertion. No other test in the crate mutates HOME.
    #[cfg(target_os = "macos")]
    static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// RAII guard: pins HOME for a test (restoring the prior value on drop, even on a
    /// panic) while holding [`HOME_LOCK`], so the ~/.claude carve-outs derive from a
    /// known temp root rather than the CI user's real home.
    #[cfg(target_os = "macos")]
    struct HomeGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
        prev: Option<std::ffi::OsString>,
    }

    #[cfg(target_os = "macos")]
    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match self.prev.take() {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn pin_home(home: &Path) -> HomeGuard {
        let lock = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var_os("HOME");
        std::env::set_var("HOME", home);
        HomeGuard { _lock: lock, prev }
    }

    /// CODEX_HOME is process-global too, but `codex_home_dir` only falls back to HOME
    /// when CODEX_HOME is unset — a SEPARATE lock (not [`HOME_LOCK`]) so a
    /// CODEX_HOME-only test doesn't serialize against unrelated HOME-only tests.
    /// Every test in this module that pins BOTH acquires `HOME_LOCK` (via
    /// [`pin_home`]) first and this lock second, consistently, so the two locks can
    /// never deadlock on lock-ordering.
    #[cfg(target_os = "macos")]
    static CODEX_HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// RAII guard: pins (or force-unsets) CODEX_HOME for a test, restoring the prior
    /// value (or absence) on drop, even on a panic, while holding [`CODEX_HOME_LOCK`].
    #[cfg(target_os = "macos")]
    struct CodexHomeGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
        prev: Option<std::ffi::OsString>,
    }

    #[cfg(target_os = "macos")]
    impl Drop for CodexHomeGuard {
        fn drop(&mut self) {
            match self.prev.take() {
                Some(v) => std::env::set_var("CODEX_HOME", v),
                None => std::env::remove_var("CODEX_HOME"),
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn pin_codex_home(codex_home: &Path) -> CodexHomeGuard {
        let lock = CODEX_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var_os("CODEX_HOME");
        std::env::set_var("CODEX_HOME", codex_home);
        CodexHomeGuard { _lock: lock, prev }
    }

    /// Force CODEX_HOME unset for a test (so `codex_home_dir` falls back to
    /// `<HOME>/.codex`) — guards against a real `codex` install on the CI/dev host
    /// leaking its own `$CODEX_HOME` into a test that expects the default.
    #[cfg(target_os = "macos")]
    fn clear_codex_home() -> CodexHomeGuard {
        let lock = CODEX_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var_os("CODEX_HOME");
        std::env::remove_var("CODEX_HOME");
        CodexHomeGuard { _lock: lock, prev }
    }

    /// Canonicalize an existing path to the kernel-resolved, symlink-free string
    /// Seatbelt (and the deriver) match — macOS temp dirs live under a /var → /private
    /// symlink, so the lexical TempDir path is NOT what lands in the roots.
    #[cfg(target_os = "macos")]
    fn canon(p: &Path) -> String {
        std::fs::canonicalize(p)
            .expect("canonicalize an existing path")
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn derive_writable_roots_includes_the_canon_cwd_but_not_its_parent() {
        let tmp = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        // A nested cwd so its parent is a distinct dir the deriver must NOT add.
        let cwd = tmp.path().join("workspace/project");
        std::fs::create_dir_all(&cwd).unwrap();

        let _home = pin_home(home.path());
        let roots = derive_writable_roots(&cwd).expect("derive roots");

        assert!(
            roots.contains(&canon(&cwd)),
            "the canonicalized cwd must be a writable root"
        );
        // The parent working dir is deliberately NOT a derived root — containment stays
        // scoped to the session cwd, never widening to its parent tree.
        let parent = canon(cwd.parent().unwrap());
        assert!(
            !roots.contains(&parent),
            "the cwd's parent must not be a writable root: {parent}"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn derive_writable_roots_includes_a_linked_worktree_git_common_dir() {
        let tmp = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        // Linked-worktree layout: cwd/.git is a FILE pointing into <repo>/.git/worktrees.
        let repo_git = tmp.path().join("repo/.git");
        std::fs::create_dir_all(repo_git.join("worktrees/wt1")).unwrap();
        let cwd = tmp.path().join("wt");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(
            cwd.join(".git"),
            format!("gitdir: {}\n", repo_git.join("worktrees/wt1").display()),
        )
        .unwrap();

        let _home = pin_home(home.path());
        let roots = derive_writable_roots(&cwd).expect("derive roots");

        assert!(
            roots.contains(&canon(&cwd)),
            "the worktree cwd is a writable root"
        );
        assert!(
            roots.contains(&canon(&repo_git)),
            "the shared .git common dir must be writable so git works in the confined worktree"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn derive_writable_roots_carves_claude_state_dirs_but_never_the_config_root() {
        let tmp = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let cwd = tmp.path().join("project");
        std::fs::create_dir_all(&cwd).unwrap();

        let _home = pin_home(home.path());
        let roots = derive_writable_roots(&cwd).expect("derive roots");

        // HOME is canonicalized inside the deriver, so build expectations from the same
        // base (the leaves are lexical — they don't exist yet).
        let claude_root = format!("{}/.claude", canon(home.path()));
        for leaf in ["session-env", "projects", "todos", "logs", "debug"] {
            let expected = format!("{claude_root}/{leaf}");
            assert!(
                roots.contains(&expected),
                "the {leaf} state dir must be a writable root"
            );
        }
        // SECURITY INVARIANT: the ~/.claude CONFIG ROOT is NEVER a writable root — a
        // confined shell that could rewrite settings.json / hooks/ would escape the
        // sandbox (Claude Code hooks run OUTSIDE the Seatbelt profile).
        assert!(
            !roots.contains(&claude_root),
            "the .claude config root must never be a writable root"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn derive_writable_roots_dedups_when_the_git_common_dir_is_the_cwd() {
        let tmp = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let cwd = tmp.path().join("wt");
        std::fs::create_dir_all(&cwd).unwrap();
        // A .git FILE whose gitdir points back at the cwd itself → the git common dir
        // resolves to the SAME path as the already-added canonical cwd, so the dedup
        // HashSet must fold it to a single entry instead of listing the cwd twice.
        std::fs::write(cwd.join(".git"), format!("gitdir: {}\n", cwd.display())).unwrap();

        let _home = pin_home(home.path());
        let roots = derive_writable_roots(&cwd).expect("derive roots");

        let canon_cwd = canon(&cwd);
        let occurrences = roots.iter().filter(|r| **r == canon_cwd).count();
        assert_eq!(
            occurrences, 1,
            "the cwd must appear exactly once even when it is also the git common dir"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn derive_writable_roots_carves_codex_state_dirs_but_never_the_config_root() {
        let tmp = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let cwd = tmp.path().join("project");
        std::fs::create_dir_all(&cwd).unwrap();

        let _home = pin_home(home.path());
        // Deterministic: fall back to <home>/.codex regardless of the host's own
        // $CODEX_HOME (a real codex install may have one set).
        let _codex_home = clear_codex_home();
        let roots = derive_writable_roots(&cwd).expect("derive roots");

        let codex_root = format!("{}/.codex", canon(home.path()));
        for leaf in ["sessions", "archived_sessions", "log", "cache", "memories"] {
            let expected = format!("{codex_root}/{leaf}");
            assert!(
                roots.contains(&expected),
                "the {leaf} codex state dir must be a writable root"
            );
        }
        // SECURITY INVARIANT: the ~/.codex ROOT is NEVER a writable root — a confined
        // shell that could rewrite config.toml / auth.json / plugins/ would escape
        // the sandbox (config.toml defines exec surfaces; auth.json is OAuth
        // credentials).
        assert!(
            !roots.contains(&codex_root),
            "the .codex config root must never be a writable root"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn derive_writable_roots_honors_a_custom_codex_home_over_the_default() {
        let tmp = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let custom_codex_home = TempDir::new().unwrap();
        let cwd = tmp.path().join("project");
        std::fs::create_dir_all(&cwd).unwrap();

        let _home = pin_home(home.path());
        let _codex_home = pin_codex_home(custom_codex_home.path());
        let roots = derive_writable_roots(&cwd).expect("derive roots");

        let custom_root = canon(custom_codex_home.path());
        assert!(
            roots.contains(&format!("{custom_root}/sessions")),
            "a custom $CODEX_HOME must be used over the default ~/.codex"
        );
        let default_codex_root = format!("{}/.codex", canon(home.path()));
        assert!(
            !roots.iter().any(|r| r.starts_with(&default_codex_root)),
            "the default ~/.codex must not be consulted when $CODEX_HOME is set"
        );
    }
}
