//! Daemon discovery, detach, and the owner-only socket path (cockpit spec PR 6,
//! §5.1 / §5.2).
//!
//! **Platform scope (§5.6, implementer decision).** The daemon ships on
//! **macOS + Linux** (Unix-domain socket + a detached session via `setsid`). On
//! Windows [`daemon_supported`] returns `false` and the terminal backend stays fully
//! in-process — the shipped read-only restore, byte-for-byte today's behavior. So
//! all the socket/spawn machinery below is `#[cfg(unix)]`; only [`daemon_supported`]
//! is cross-platform.
//!
//! **Auth = filesystem permissions (§5.2).** The socket lives in a `0700`
//! owner-only directory and is itself chmod'd `0600` after bind. There is no network
//! transport and no token: the OS permission boundary IS the auth — only the owning
//! user can open the path. (A `SO_PEERCRED`/`LOCAL_PEERCRED` uid double-check is a
//! deferred nicety; it needs a `libc`/`nix` dep and the perms boundary already
//! restricts to the owner. Flagged in the PR body, not silently skipped.)

/// Whether this platform supports the detached PTY daemon. macOS + Linux only in v1
/// (§5.6); everywhere else the backend stays in-process and read-only-restores like
/// today. The settings toggle is a no-op on an unsupported platform (no dead UI —
/// the toggle explains the platform requirement).
pub(crate) const fn daemon_supported() -> bool {
    cfg!(unix)
}

#[cfg(unix)]
pub(crate) use imp::*;

#[cfg(unix)]
mod imp {
    use std::collections::hash_map::DefaultHasher;
    use std::fs;
    use std::hash::{Hash, Hasher};
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    /// The default idle-with-zero-sessions-and-zero-clients grace before the daemon
    /// self-exits (§5.4 / risk register). Short: with zero sessions there is nothing
    /// to reattach to, so a lingering daemon is pure waste. A daemon holding LIVE
    /// sessions never idle-exits (session_count > 0), so a closed-then-relaunched app
    /// still reattaches.
    pub(crate) const DEFAULT_IDLE_GRACE_SECS: u64 = 30;

    /// The effective uid, for a per-user socket directory name in the shared temp
    /// base. Linked from libc (always present on Unix); pure syscall, no crate.
    fn euid() -> u32 {
        // SAFETY: `geteuid` is a trivial, always-succeeds C syscall with no arguments
        // and no memory effects.
        unsafe {
            extern "C" {
                fn geteuid() -> u32;
            }
            geteuid()
        }
    }

    /// The base directory holding this user's daemon sockets: `$XDG_RUNTIME_DIR` when
    /// set (Linux), else `/tmp` (short — Unix `sun_path` caps at ~104 bytes, so a long
    /// `$TMPDIR` like macOS's `/var/folders/…` is avoided). A `nightcore-pty-<uid>`
    /// subdir is created `0700` so only the owner can traverse to the socket.
    fn socket_base_dir() -> io::Result<PathBuf> {
        let root = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| PathBuf::from("/tmp"));
        let dir = root.join(format!("nightcore-pty-{}", euid()));
        fs::create_dir_all(&dir)?;
        // Owner-only (0700) — the auth boundary (§5.2). Best-effort tighten on an
        // existing dir too (a prior looser mode is corrected).
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        Ok(dir)
    }

    /// A short, stable token identifying a project's daemon, derived from its persist
    /// dir (`…/.nightcore/terminals`). `DefaultHasher` is deterministic within a
    /// build (fixed SipHash keys), which is all that is needed — the same binary
    /// writes and later reads the name. Keeps the socket filename short for the
    /// `sun_path` limit.
    fn project_token(persist_dir: &Path) -> String {
        let mut hasher = DefaultHasher::new();
        persist_dir.hash(&mut hasher);
        format!("{:016x}", hasher.finish())
    }

    /// The owner-only Unix-socket path for the daemon serving `persist_dir`'s project.
    /// Creates the `0700` parent dir as a side effect.
    pub(crate) fn socket_path(persist_dir: &Path) -> io::Result<PathBuf> {
        Ok(socket_base_dir()?.join(format!("{}.sock", project_token(persist_dir))))
    }

    /// Tighten a freshly-bound socket to `0600` (owner read/write only). Called right
    /// after `UnixListener::bind` so the window before the chmod is a private `0700`
    /// dir anyway.
    pub(crate) fn set_socket_perms(path: &Path) -> io::Result<()> {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
    }

    /// Spawn THIS executable, re-invoked in the hidden `--terminal-daemon` mode, as a
    /// DETACHED session that outlives the app window (§5.1). `setsid` (via `pre_exec`)
    /// puts the child in a new session with no controlling terminal, so closing the
    /// app — or the terminal that launched a `tauri dev` run — never `SIGHUP`s the
    /// daemon or its shells; `process_group(0)` additionally isolates it from the
    /// parent's job-control group. std fds are redirected to `/dev/null` and the child
    /// is NOT waited on, so it is fully orphaned to `init`.
    ///
    /// Returns once the child is spawned; the caller then connects to `socket` (with a
    /// short retry while the daemon binds). A spawn failure degrades to in-process
    /// (the caller logs + falls back to read-only restore).
    pub(crate) fn spawn_detached(
        socket: &Path,
        persist_dir: &Path,
        idle_secs: u64,
    ) -> io::Result<()> {
        let exe = std::env::current_exe()?;
        let mut cmd = Command::new(exe);
        cmd.arg("--terminal-daemon")
            .arg("--socket")
            .arg(socket)
            .arg("--persist-dir")
            .arg(persist_dir)
            .arg("--idle-secs")
            .arg(idle_secs.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            // New process group: detaches from the app's job-control group.
            .process_group(0);
        // SAFETY: `setsid` is async-signal-safe and the only call in the post-fork,
        // pre-exec child here. Detaching the controlling terminal is exactly the
        // documented intent; a non-zero return is tolerated (already a group leader).
        unsafe {
            cmd.pre_exec(|| {
                extern "C" {
                    fn setsid() -> i32;
                }
                setsid();
                Ok(())
            });
        }
        cmd.spawn().map(|_child| {
            // Drop the child handle immediately — we never wait on the daemon; it is
            // reparented to init and lives independently of this process.
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn socket_path_is_short_owner_only_and_stable() {
            let dir = std::env::temp_dir().join("nc-pty-test-project/.nightcore/terminals");
            let a = socket_path(&dir).expect("derive socket path");
            let b = socket_path(&dir).expect("derive again");
            assert_eq!(a, b, "the same persist dir yields the same socket path");
            assert!(a.extension().is_some_and(|e| e == "sock"));
            // Comfortably under the ~104-byte Unix sun_path limit.
            assert!(
                a.as_os_str().len() < 104,
                "socket path {} is too long ({} bytes)",
                a.display(),
                a.as_os_str().len()
            );
            // The parent dir was created 0700.
            let parent = a.parent().unwrap();
            let mode = fs::metadata(parent).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "socket dir must be owner-only");
        }

        #[test]
        fn different_projects_get_different_sockets() {
            let a = socket_path(Path::new("/tmp/nc-proj-a/.nightcore/terminals")).unwrap();
            let b = socket_path(Path::new("/tmp/nc-proj-b/.nightcore/terminals")).unwrap();
            assert_ne!(a, b);
        }
    }
}

/// Cross-platform assertion for the docs/tests: `daemon_supported()` mirrors `unix`.
#[cfg(test)]
mod tests {
    use super::daemon_supported;

    #[test]
    fn supported_matches_the_platform() {
        assert_eq!(daemon_supported(), cfg!(unix));
    }
}
