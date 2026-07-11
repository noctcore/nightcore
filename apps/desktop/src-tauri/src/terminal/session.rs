//! One PTY session: spawn via `portable-pty`, a blocking reader thread, a
//! coalescer thread that batches output into the sink + maintains the scrollback
//! ring, and the write/resize/kill primitives. All session state is owned here; the
//! registry only holds a map of these behind a `Mutex`.
//!
//! Thread discipline (the terax-ai/wezterm recipe, feasibility §2):
//!  - `drop(slave)` immediately after spawn so the reader sees EOF once the child's
//!    slave fds close;
//!  - `take_writer()` up front (EOF-on-drop is the writer's contract);
//!  - the blocking reader lives on its OWN thread (`portable-pty` is strictly
//!    blocking std::io) and reaps the child with `wait()` after EOF;
//!  - a separate coalescer thread turns reader chunks into batched sends + ring
//!    updates + periodic/on-exit scrollback persistence.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};

use super::confine;
use super::persist::{self, PersistedScrollback};
use super::scrollback::{CoalesceConfig, Coalescer, ScrollbackRing};
use super::shell::{interactive_args, resolve_shell};
use super::types::TerminalSessionInfo;

/// The sink a session streams coalesced output batches into. The command layer
/// wraps a `tauri::ipc::Channel` (binary `Raw` frames); tests pass a collector.
pub(crate) type OutputSink = Box<dyn Fn(Vec<u8>) + Send + 'static>;

/// Reader buffer size — a full read rides Tauri's binary fetch path after coalescing.
const READ_BUF: usize = 32 * 1024;

/// How often the coalescer thread flushes the scrollback ring to disk while a
/// session is active (crash-safety; the exact cadence is the implementer's call
/// per the spec). Also always flushed on session exit.
const PERSIST_INTERVAL: Duration = Duration::from_secs(15);

/// Idle wakeup when nothing is pending — bounds how long the coalescer sleeps
/// between periodic-persist checks.
const IDLE_TICK: Duration = Duration::from_millis(200);

/// What the caller passes to spawn a session.
pub(crate) struct SpawnOpts {
    pub(crate) cwd: PathBuf,
    pub(crate) confined: bool,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
}

/// Metadata the coalescer thread needs to persist scrollback without reaching back
/// into the registry.
struct PersistCtx {
    dir: PathBuf,
    id: String,
    cwd: String,
    shell: String,
    confined: bool,
    created_at: u64,
    /// The manual tab name (decision 5), shared with the live session so a rename
    /// after spawn is picked up by the next scrollback flush.
    title: Arc<Mutex<Option<String>>>,
}

/// A live PTY session. Owns the master (for resize), the writer (for input), and a
/// killer (thread-safe terminate). The reader/coalescer threads are DETACHED — they
/// self-terminate when the child exits (reader EOF → coalescer channel disconnect →
/// final flush), and `kill()`/`Drop` tear the child down to trigger that.
pub(crate) struct PtySession {
    id: String,
    cwd: PathBuf,
    shell: String,
    confined: bool,
    created_at: u64,
    cols: u16,
    rows: u16,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    alive: Arc<AtomicBool>,
    /// The user's manual name for this tab (decision 5), or `None` when unnamed.
    /// Behind an `Arc<Mutex<_>>` shared with the coalescer's `PersistCtx` so a
    /// rename survives a scrollback flush + a read-only restore.
    title: Arc<Mutex<Option<String>>>,
}

impl PtySession {
    /// Spawn a shell in `opts.cwd`, wiring the reader/coalescer threads. `sink`
    /// receives coalesced output batches; `persist_dir` is where scrollback is
    /// serialized on exit + periodically. FAIL-CLOSED on confinement (decision 1):
    /// a confined spawn whose Seatbelt profile can't be assembled errors rather
    /// than launching unconfined.
    pub(crate) fn spawn(
        id: String,
        opts: SpawnOpts,
        sink: OutputSink,
        persist_dir: PathBuf,
    ) -> Result<Self, String> {
        // Platform-aware + existence-validated resolution (Unix `$SHELL`→zsh→bash→sh,
        // Windows pwsh→powershell→%COMSPEC%→cmd). The resolver only ever returns an
        // existing shell, which also covers the wezterm#7893 pre-validation (a bad
        // program path aborts the child AFTER `spawn` returns Ok, once the CLOEXEC
        // exec-error pipe is swept), so a missing shell surfaces as a named error
        // here rather than a mystery immediate exit.
        let shell = resolve_shell()?;
        // Interactive flags are shell-family aware (POSIX shells get `-i`; pwsh gets
        // `-NoLogo`; cmd.exe gets nothing) — an interactive, non-login shell sources
        // the user's rc files for prompt/aliases without a full login profile.
        let args = interactive_args(&shell);

        let cmd = build_command(&shell, &args, &opts)?;

        let size = PtySize {
            rows: opts.rows.max(1),
            cols: opts.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| format!("openpty failed: {e}"))?;
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn shell {shell}: {e}"))?;
        // Drop the slave immediately: the reader only sees EOF once every slave fd
        // is closed (feasibility §2).
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone pty reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take pty writer: {e}"))?;
        let killer = child.clone_killer();

        let alive = Arc::new(AtomicBool::new(true));
        let scrollback = Arc::new(Mutex::new(ScrollbackRing::with_defaults()));
        let title: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let created_at = persist::now_ms();

        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        spawn_reader_thread(reader, child, tx, Arc::clone(&alive));
        spawn_coalescer_thread(
            rx,
            Arc::clone(&scrollback),
            sink,
            PersistCtx {
                dir: persist_dir,
                id: id.clone(),
                cwd: opts.cwd.to_string_lossy().into_owned(),
                shell: shell.clone(),
                confined: opts.confined,
                created_at,
                title: Arc::clone(&title),
            },
        );

        Ok(Self {
            id,
            cwd: opts.cwd,
            shell,
            confined: opts.confined,
            created_at,
            cols: size.cols,
            rows: size.rows,
            master: pair.master,
            writer,
            killer,
            alive,
            title,
        })
    }

    /// Set (or clear, with `None`) the user's manual name for this tab. `&self`:
    /// the title is behind an `Arc<Mutex<_>>`, so the registry updates it without a
    /// mutable session borrow. The next scrollback flush persists it via `PersistCtx`.
    pub(crate) fn set_title(&self, title: Option<String>) {
        if let Ok(mut slot) = self.title.lock() {
            *slot = title;
        }
    }

    /// Write user input to the shell. Small keystroke/paste writes; a closed pty
    /// surfaces as an error the command layer toasts.
    pub(crate) fn write(&mut self, data: &[u8]) -> Result<(), String> {
        self.writer
            .write_all(data)
            .and_then(|()| self.writer.flush())
            .map_err(|e| format!("terminal write failed: {e}"))
    }

    /// Resize the pty (delivers SIGWINCH to the child).
    pub(crate) fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        let size = PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        self.master
            .resize(size)
            .map_err(|e| format!("terminal resize failed: {e}"))?;
        self.cols = size.cols;
        self.rows = size.rows;
        Ok(())
    }

    /// Terminate the shell. The reader thread then sees EOF, reaps the child, and
    /// the coalescer thread makes a final scrollback flush. Idempotent.
    pub(crate) fn kill(&mut self) {
        let _ = self.killer.kill();
        self.alive.store(false, Ordering::SeqCst);
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub(crate) fn cwd(&self) -> &std::path::Path {
        &self.cwd
    }

    pub(crate) fn info(&self) -> TerminalSessionInfo {
        TerminalSessionInfo {
            id: self.id.clone(),
            cwd: self.cwd.to_string_lossy().into_owned(),
            shell: self.shell.clone(),
            confined: self.confined,
            cols: self.cols,
            rows: self.rows,
            alive: self.is_alive(),
            created_at: self.created_at,
            title: self.title.lock().ok().and_then(|t| t.clone()),
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Never leave an orphan shell when the registry entry goes away (app exit,
        // reap, discard). A double-kill is harmless.
        self.kill();
    }
}

/// Assemble the `CommandBuilder` for a spawn: the shell (bare, or wrapped by the
/// macOS confinement launcher) with its interactive args, the cwd, and the base
/// terminal env. A CONFINED spawn additionally inherits the launcher's shell-state
/// env redirect (history / cache / compdump → temp; see `confine`), so a first run
/// doesn't spam `$HOME` write denials; an UNCONFINED spawn gets none of that — a
/// normal shell keeps normal history in `$HOME`. Split out from [`PtySession::spawn`]
/// so the env assembly is unit-testable without opening a pty. FAIL-CLOSED: a
/// confined spawn whose Seatbelt profile can't be assembled returns an error.
fn build_command(shell: &str, args: &[&str], opts: &SpawnOpts) -> Result<CommandBuilder, String> {
    let mut cmd = if opts.confined {
        // Confinement is opt-in + macOS-only + fail-closed (see `confine`).
        let launch = confine::prepare(&opts.cwd)?;
        let mut c = CommandBuilder::new(&launch.program);
        c.args(&launch.prefix_args);
        c.arg(shell);
        for arg in args {
            c.arg(arg);
        }
        // Redirect shell housekeeping into the writable temp state dir (see `confine`).
        for (key, value) in &launch.env {
            c.env(key, value);
        }
        c
    } else {
        let mut c = CommandBuilder::new(shell);
        for arg in args {
            c.arg(arg);
        }
        c
    };
    cmd.cwd(&opts.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    Ok(cmd)
}

/// The blocking reader loop: read → forward raw chunks to the coalescer → on
/// EOF/error, mark dead + reap the child. Owns the reader + child so the reaping
/// `wait()` never contends with the writer/killer held by the session.
fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    tx: mpsc::Sender<Vec<u8>>,
    alive: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; READ_BUF];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — every slave fd closed (child exited)
                Ok(n) => {
                    // A dropped coalescer (session torn down) ends the loop.
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        alive.store(false, Ordering::SeqCst);
        // The child has exited (that is why we hit EOF), so this returns promptly.
        let _ = child.wait();
        // `tx` drops here → the coalescer sees `Disconnected` and does its final flush.
    })
}

/// The coalescer loop: accumulate reader chunks, flush batches on the size/time
/// boundary into the scrollback ring + sink, persist periodically, and make one
/// final flush + persist when the reader disconnects.
fn spawn_coalescer_thread(
    rx: Receiver<Vec<u8>>,
    scrollback: Arc<Mutex<ScrollbackRing>>,
    sink: OutputSink,
    ctx: PersistCtx,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut coalescer = Coalescer::new(CoalesceConfig::default());
        let mut last_persist = Instant::now();

        let apply = |batch: Vec<u8>| {
            if let Ok(mut ring) = scrollback.lock() {
                ring.push(&batch);
            }
            sink(batch);
        };

        loop {
            let timeout = coalescer
                .deadline()
                .map(|d| d.saturating_duration_since(Instant::now()))
                .unwrap_or(IDLE_TICK);
            match rx.recv_timeout(timeout) {
                Ok(chunk) => {
                    if let Some(batch) = coalescer.push(&chunk, Instant::now()) {
                        apply(batch);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if let Some(batch) = coalescer.flush_due(Instant::now()) {
                        apply(batch);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    if let Some(batch) = coalescer.drain() {
                        apply(batch);
                    }
                    persist_scrollback(&scrollback, &ctx);
                    break;
                }
            }
            if last_persist.elapsed() >= PERSIST_INTERVAL {
                persist_scrollback(&scrollback, &ctx);
                last_persist = Instant::now();
            }
        }
    })
}

/// Snapshot the ring and write it to disk (best-effort — logged, never fatal).
fn persist_scrollback(scrollback: &Arc<Mutex<ScrollbackRing>>, ctx: &PersistCtx) {
    let snapshot = match scrollback.lock() {
        Ok(ring) => ring.snapshot(),
        Err(_) => return,
    };
    let title = ctx
        .title
        .lock()
        .ok()
        .and_then(|t| t.clone())
        .unwrap_or_default();
    let record = PersistedScrollback::new(
        ctx.id.clone(),
        ctx.cwd.clone(),
        ctx.shell.clone(),
        ctx.confined,
        ctx.created_at,
        persist::now_ms(),
        title,
        &snapshot,
    );
    if let Err(e) = persist::write(&ctx.dir, &record) {
        tracing::warn!(session = %ctx.id, "failed to persist terminal scrollback: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::Duration;
    use tempfile::TempDir;

    /// A sink that forwards every batch to a channel so a test can await output.
    fn collecting_sink() -> (OutputSink, mpsc::Receiver<Vec<u8>>) {
        let (tx, rx) = channel::<Vec<u8>>();
        let sink: OutputSink = Box::new(move |bytes| {
            let _ = tx.send(bytes);
        });
        (sink, rx)
    }

    /// Drain the sink until `needle` is seen or the deadline passes.
    fn wait_for(rx: &mpsc::Receiver<Vec<u8>>, needle: &[u8]) -> Vec<u8> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut acc = Vec::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(chunk) => {
                    acc.extend_from_slice(&chunk);
                    if acc.windows(needle.len()).any(|w| w == needle) {
                        return acc;
                    }
                }
                Err(_) => continue,
            }
        }
        acc
    }

    #[test]
    fn unconfined_command_sets_no_shell_state_redirect() {
        // A normal shell keeps normal history: the confined redirect vars must be
        // absent, but the base terminal env is still applied.
        let tmp = TempDir::new().unwrap();
        let opts = SpawnOpts {
            cwd: tmp.path().to_path_buf(),
            confined: false,
            cols: 80,
            rows: 24,
        };
        let cmd = build_command("/bin/sh", &["-i"], &opts).expect("unconfined command");
        assert!(cmd.get_env("HISTFILE").is_none());
        assert!(cmd.get_env("XDG_CACHE_HOME").is_none());
        assert!(cmd.get_env("ZSH_COMPDUMP").is_none());
        assert_eq!(
            cmd.get_env("TERM").unwrap().to_string_lossy(),
            "xterm-256color"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn confined_command_redirects_shell_state_into_a_created_temp_dir() {
        // A confined spawn threads the launcher's env onto the command: the three
        // redirect vars must be present, share one per-session state dir, and that dir
        // must already exist (pre-created) — all under the temp tree, never $HOME.
        let tmp = TempDir::new().unwrap();
        let opts = SpawnOpts {
            cwd: tmp.path().to_path_buf(),
            confined: true,
            cols: 80,
            rows: 24,
        };
        let cmd = build_command("/bin/zsh", &["-i"], &opts).expect("confined command");
        let read = |key: &str| {
            cmd.get_env(key)
                .unwrap_or_else(|| panic!("{key} is set"))
                .to_string_lossy()
                .into_owned()
        };
        let histfile = read("HISTFILE");
        let cache = read("XDG_CACHE_HOME");
        let compdump = read("ZSH_COMPDUMP");
        let state_dir = std::path::Path::new(&histfile).parent().unwrap();
        assert!(state_dir.is_dir(), "the shell-state dir was pre-created");
        assert_eq!(std::path::Path::new(&cache).parent().unwrap(), state_dir);
        assert_eq!(std::path::Path::new(&compdump).parent().unwrap(), state_dir);
        assert!(histfile.contains("nightcore-term-sandbox"));
        assert!(histfile.ends_with("zsh_history"));
    }

    #[test]
    #[cfg(unix)]
    fn real_pty_echo_round_trips_through_the_reader_and_coalescer() {
        // Integration: a real portable-pty shell must echo a marker back through the
        // reader → coalescer → sink seam. CI-safe (no TTY assumptions beyond
        // portable-pty's own); asserts only our own injected marker, never
        // env-dependent shell output.
        let tmp = TempDir::new().unwrap();
        let (sink, rx) = collecting_sink();
        let mut session = PtySession::spawn(
            "echo-test".to_string(),
            SpawnOpts {
                cwd: tmp.path().to_path_buf(),
                confined: false,
                cols: 80,
                rows: 24,
            },
            sink,
            tmp.path().join("terminals"),
        )
        .expect("spawn a real pty");

        session.write(b"printf NIGHTCORE_OK\\\\n\n").expect("write");
        let out = wait_for(&rx, b"NIGHTCORE_OK");
        assert!(
            out.windows(12).any(|w| w == b"NIGHTCORE_OK"),
            "the shell echoed our marker back through the pipeline; got {} bytes",
            out.len()
        );

        session.kill();
    }

    #[test]
    #[cfg(unix)]
    fn scrollback_persists_on_session_exit() {
        // When the shell exits, the coalescer's final flush must write the scrollback
        // to disk so a later relaunch can restore it read-only (decision 3).
        let tmp = TempDir::new().unwrap();
        let persist_dir = tmp.path().join("terminals");
        let (sink, rx) = collecting_sink();
        let mut session = PtySession::spawn(
            "exit-test".to_string(),
            SpawnOpts {
                cwd: tmp.path().to_path_buf(),
                confined: false,
                cols: 80,
                rows: 24,
            },
            sink,
            persist_dir.clone(),
        )
        .expect("spawn");

        session
            .write(b"printf DONE_MARKER\\\\n\nexit\n")
            .expect("write");
        let _ = wait_for(&rx, b"DONE_MARKER");

        // Give the reader EOF + coalescer final-flush a moment after `exit`.
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && persist::read(&persist_dir, "exit-test").is_none() {
            std::thread::sleep(Duration::from_millis(100));
        }
        let bytes = persist::read_bytes(&persist_dir, "exit-test")
            .expect("scrollback was persisted on exit");
        assert!(
            bytes.windows(11).any(|w| w == b"DONE_MARKER"),
            "the persisted scrollback contains the marker"
        );
    }
}
