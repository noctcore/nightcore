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
//! **Auth = filesystem permissions + a peer-cred uid check (§5.2).** The socket lives
//! in a `0700` owner-only directory and is itself chmod'd `0600` after bind. There is
//! no network transport and no token: the OS permission boundary IS the first line of
//! auth — only the owning user can open the path. On top of that, [`peer_uid`] reads
//! the connecting client's kernel-reported uid (`SO_PEERCRED` on Linux, `getpeereid`
//! on macOS/BSD) on EVERY accepted connection (`server::Server::peer_authorized`), and
//! a peer whose uid differs from the daemon's own [`euid`] is logged at WARN and
//! dropped — never served (terminal round 2, PR D). The uid comparison is done against
//! [`euid`] only, and any error reading the credential fails CLOSED (refuse), so a
//! stray connection can only ever cost that one daemon connection — the app still
//! degrades to the in-process PTY + read-only restore.

/// Whether this platform supports the detached PTY daemon. macOS + Linux only (§5.6);
/// everywhere else the backend stays in-process and read-only-restores like today. The
/// settings toggle is a no-op on an unsupported platform (no dead UI — the toggle
/// explains the platform requirement).
///
/// **Windows parity is a planned follow-up (terminal round 2, PR D, deferred).** The
/// Unix half of PR D — the per-connection peer-cred uid check ([`peer_uid`]) — shipped;
/// the Windows daemon did not. Bringing live-PTY survival to Windows means mirroring
/// the Unix seam WITHOUT touching it (§5.1, "do not rip out the working Unix socket"):
///   1. a **named-pipe transport** (`\\.\pipe\nightcore-pty-<user-scoped-id>`) carrying
///      the identical transport-agnostic [`super::protocol`] frames — a `Read + Write`
///      pipe stream + one-thread-per-client accept loop mirroring the Unix
///      `std::thread` model (server/client/fanout abstract over the stream type);
///   2. a **`CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS`** detached spawn (std
///      `CommandExt::creation_flags`) — the Windows analog of the Unix `setsid`
///      re-invoke in [`spawn_detached`];
///   3. an **owner-only DACL** (`SECURITY_ATTRIBUTES` restricting the pipe to the
///      current-user SID) as the Windows analog of `0600` + this peer-cred check;
///   4. flipping this fn to `true` on Windows ONLY once (1)-(3) exist and have passed an
///      on-hardware create -> detach -> reattach -> kill dogfood pass.
///
/// Until then Windows keeps the shipped read-only restore — the degradation floor — so
/// nothing regresses and no live shell can be orphaned by an unverified transport.
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

    /// The effective uid — used both for the per-user socket directory name and as the
    /// authority the peer-cred check compares every connection against ([`peer_uid`]).
    pub(crate) fn euid() -> u32 {
        // SAFETY: `geteuid` is a trivial, always-succeeds C syscall with no arguments
        // and no memory effects.
        unsafe { libc::geteuid() }
    }

    /// The kernel-reported uid of the process on the other end of `stream` — the
    /// peer-cred check (terminal round 2, PR D). The daemon compares this to its own
    /// [`euid`] on every accepted connection and refuses a mismatch, closing the gap
    /// left by the filesystem-perms-only auth. Errors are the caller's cue to fail
    /// closed (refuse the connection), never to serve it.
    ///
    /// Platform split (per-OS, `#[cfg(target_os)]`): Linux uses `getsockopt` with
    /// `SO_PEERCRED` → `struct ucred`; macOS/BSD use `getpeereid` (the portable
    /// cross-BSD call). Both are read via `libc` — no hand-rolled struct layout.
    pub(crate) fn peer_uid(stream: &std::os::unix::net::UnixStream) -> io::Result<u32> {
        use std::os::unix::io::AsRawFd;
        peer_uid_of_fd(stream.as_raw_fd())
    }

    #[cfg(target_os = "linux")]
    fn peer_uid_of_fd(fd: std::os::unix::io::RawFd) -> io::Result<u32> {
        let mut cred = libc::ucred {
            pid: 0,
            uid: 0,
            gid: 0,
        };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: `getsockopt(SO_PEERCRED)` writes up to `len` bytes into `cred` on
        // success; we pass a matching zero-initialized `ucred` and its exact size, and
        // check the return code before reading the result.
        let rc = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut cred as *mut libc::ucred).cast::<libc::c_void>(),
                &mut len,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(cred.uid)
    }

    #[cfg(not(target_os = "linux"))]
    fn peer_uid_of_fd(fd: std::os::unix::io::RawFd) -> io::Result<u32> {
        let mut uid: libc::uid_t = 0;
        let mut gid: libc::gid_t = 0;
        // SAFETY: `getpeereid` writes the peer's uid/gid into the two valid, initialized
        // out-params on success; we check the return code before reading `uid`.
        let rc = unsafe { libc::getpeereid(fd, &mut uid, &mut gid) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(uid)
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

        #[test]
        fn peer_uid_of_a_local_socket_is_our_own_euid() {
            // The real `SO_PEERCRED`/`getpeereid` FFI: both ends of an in-process
            // socketpair are this same process, so the kernel reports OUR euid — the
            // value the daemon requires a peer to match. This exercises the syscall
            // without a second OS user; the reject path (a mismatching expected uid) is
            // covered in the daemon integration tests.
            let (a, b) = std::os::unix::net::UnixStream::pair().expect("socketpair");
            assert_eq!(peer_uid(&a).expect("peer uid of end a"), euid());
            assert_eq!(peer_uid(&b).expect("peer uid of end b"), euid());
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
