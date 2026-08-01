//! The live-child harness for ring 3(b): boot the COMPILED sidecar against a
//! scratch git repo, hand its stdin to a real [`SidecarProvider`], and expose the
//! stdout stream as decoded [`NightcoreEvent`]s plus the raw stderr log.
//!
//! Everything here is fixture plumbing. The assertions live in
//! [`super::contract`]; the production code under test is
//! `provider::{start_session, query, correlate, correlate_reply}` and
//! `provider::parse_line`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::contracts::NightcoreEvent;
use crate::git::testutil::git_expect;
use crate::provider::{parse_line, SidecarProvider};

/// Ceiling on any single wait. The replay is unpaced (milliseconds in practice);
/// this exists so a wedged child fails the test fast instead of hanging `cargo
/// test` until the CI job's own timeout.
const WAIT_TIMEOUT: Duration = Duration::from_secs(30);

/// The repo root, derived from this crate's manifest dir
/// (`apps/desktop/src-tauri` → `../../..`).
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("crate manifest dir is three levels below the repo root")
        .to_path_buf()
}

/// The ONE copy of the ladder's transcripts, shared with ring 1(c)'s Rust drivers
/// and ring 3's Bun harness.
fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/e2e/transcript_replay/fixtures")
}

/// The compiled sidecar Tauri bundles as `externalBin`, resolved by its
/// triple-suffixed name. `tauri_build` refuses to build this crate without it, so a
/// missing binary here means something removed that guarantee — we panic with the
/// command that rebuilds it rather than skipping (a skipped boundary proof reads
/// exactly like a passing one).
fn sidecar_binary() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let found = std::fs::read_dir(&dir).ok().and_then(|entries| {
        entries.flatten().map(|e| e.path()).find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("nightcore-sidecar-"))
        })
    });
    found.unwrap_or_else(|| {
        panic!(
            "no compiled sidecar in {} — run `bun run --filter @nightcore/sidecar compile` \
             (`bun run test:rust` does it for you)",
            dir.display()
        )
    })
}

/// One decoded line off the live wire, or the diagnosis of why it could not be
/// decoded. An `Err` is an assertion failure the test surfaces verbatim — never a
/// dropped line.
type WireLine = Result<NightcoreEvent, String>;

/// A booted sidecar child plus the core-side plumbing pointed at it.
pub(super) struct Boundary {
    provider: Arc<SidecarProvider>,
    events: mpsc::UnboundedReceiver<WireLine>,
    stderr: Arc<Mutex<Vec<String>>>,
    /// Held until `adopt_into_provider`/`write_raw_line` takes it.
    stdin: Option<tokio::process::ChildStdin>,
    /// Killed on drop (`kill_on_drop`), so no test can leak a child.
    _child: tokio::process::Child,
    /// The scratch repo the session runs in. Dropped with the harness.
    scratch: TempDir,
    _home: TempDir,
}

impl Boundary {
    /// Boot the compiled sidecar in replay mode against a fresh scratch git repo.
    pub(super) fn boot() -> Self {
        let home = TempDir::new().expect("temp home");
        let scratch = TempDir::new().expect("temp scratch repo");
        // A REAL git repo, the way a user's project is — built through the crate's
        // one sanctioned fixture git runner (hermetic identity, scrubbed git env).
        git_expect(scratch.path(), &["init", "--initial-branch=main"]);
        std::fs::write(scratch.path().join("README.md"), "scratch\n").expect("seed file");
        git_expect(scratch.path(), &["add", "README.md"]);
        git_expect(scratch.path(), &["commit", "-m", "seed"]);

        let mut child = Command::new(sidecar_binary())
            // The child's cwd is the SCRATCH repo, never the nightcore checkout.
            .current_dir(scratch.path())
            // The switch that puts the ladder's ReplayAgentProvider in the registry.
            // Set-but-unreadable throws inside the engine, so a typo here reds the
            // test instead of quietly reaching for a live account.
            .env("NIGHTCORE_E2E_REPLAY", fixtures_dir())
            // Hermetic: the engine's session store and every config lookup land in a
            // temp dir, never the developer's real home.
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            // Production always sets this; setting it here proves the replay registry
            // preempts the configured provider (it must, or a "free" CI ring could
            // reach a real account).
            .env("NIGHTCORE_PROVIDER", "claude")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the compiled sidecar");

        let stdin = child.stdin.take().expect("child stdin");
        let stdout = child.stdout.take().expect("child stdout");
        let child_stderr = child.stderr.take().expect("child stderr");

        let provider = Arc::new(SidecarProvider::new(
            repo_root().join("apps/sidecar/src/index.ts"),
            scratch.path().to_path_buf(),
            "claude".to_string(),
        ));

        let (tx, events) = mpsc::unbounded_channel::<WireLine>();
        let reader_provider = Arc::clone(&provider);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(raw)) = lines.next_line().await {
                // The PRODUCTION NDJSON line parser (`sidecar::transport`'s reader
                // loop calls exactly this).
                let value = match parse_line(&raw) {
                    None => continue,
                    Some(Ok(value)) => value,
                    Some(Err(e)) => {
                        let _ = tx.send(Err(e));
                        continue;
                    }
                };
                // Mirror the production reader's `query-result` arm: an RPC reply is
                // routed back to the awaiting `Provider::query` by `requestId`.
                if value.get("type").and_then(Value::as_str) == Some("query-result") {
                    if let Some(id) = value.get("requestId").and_then(Value::as_str) {
                        use crate::provider::Provider;
                        reader_provider.correlate_reply(id, value.clone());
                    }
                }
                let decoded = serde_json::from_value::<NightcoreEvent>(value).map_err(|e| {
                    format!("the core could not decode a LIVE sidecar line ({e}): {raw}")
                });
                let _ = tx.send(decoded);
            }
        });

        let stderr = Arc::new(Mutex::new(Vec::<String>::new()));
        let stderr_sink = Arc::clone(&stderr);
        tokio::spawn(async move {
            let mut lines = BufReader::new(child_stderr).lines();
            while let Ok(Some(raw)) = lines.next_line().await {
                crate::sync::lock_or_recover(&stderr_sink).push(raw);
            }
        });

        Self {
            provider,
            events,
            stderr,
            stdin: Some(stdin),
            _child: child,
            scratch,
            _home: home,
        }
    }

    /// The real provider, with the live child's stdin adopted, so every command the
    /// test issues travels the PRODUCTION writer over the real pipe.
    pub(super) async fn provider(&mut self) -> Arc<SidecarProvider> {
        if let Some(stdin) = self.stdin.take() {
            self.provider.adopt_stdin_for_test(stdin).await;
        }
        Arc::clone(&self.provider)
    }

    /// Write one raw NDJSON line straight to the child, bypassing the provider.
    /// Used ONLY by the anti-vacuity test, which must emit bytes the typed
    /// production writer cannot construct.
    pub(super) async fn write_raw_line(&mut self, line: &str) {
        use tokio::io::AsyncWriteExt;
        let stdin = self.stdin.as_mut().expect("stdin not yet adopted");
        stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .expect("write raw line");
        stdin.flush().await.expect("flush raw line");
    }

    /// The scratch git repo the session should run in.
    pub(super) fn scratch(&self) -> PathBuf {
        self.scratch.path().to_path_buf()
    }

    /// Await the first event satisfying `matches`, failing the test on a decode
    /// error, on the child closing its stdout, or on {@link WAIT_TIMEOUT}.
    pub(super) async fn wait_for(
        &mut self,
        what: &str,
        matches: impl Fn(&NightcoreEvent) -> bool,
    ) -> NightcoreEvent {
        let mut seen: Vec<String> = Vec::new();
        let deadline = tokio::time::Instant::now() + WAIT_TIMEOUT;
        loop {
            let next = tokio::time::timeout_at(deadline, self.events.recv()).await;
            match next {
                Ok(Some(Ok(event))) => {
                    if matches(&event) {
                        return event;
                    }
                    seen.push(event_type_of(&event));
                }
                Ok(Some(Err(e))) => panic!("{e}"),
                Ok(None) => panic!(
                    "the sidecar closed stdout before {what}; saw [{}]; stderr:\n{}",
                    seen.join(", "),
                    self.stderr_text()
                ),
                Err(_) => panic!(
                    "timed out after {WAIT_TIMEOUT:?} waiting for {what}; saw [{}]; stderr:\n{}",
                    seen.join(", "),
                    self.stderr_text()
                ),
            }
        }
    }

    /// Assert NO event satisfying `matches` arrives within `window` — the negative
    /// half of the anti-vacuity proof (a rejected command must produce silence on
    /// stdout, not a session).
    pub(super) async fn expect_silence(
        &mut self,
        what: &str,
        window: Duration,
        matches: impl Fn(&NightcoreEvent) -> bool,
    ) {
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(Some(line)) = tokio::time::timeout_at(deadline, self.events.recv()).await {
            if let Ok(event) = line {
                assert!(
                    !matches(&event),
                    "expected no {what}, but the sidecar emitted {}",
                    event_type_of(&event)
                );
            }
        }
    }

    /// Everything the child has written to stderr so far (its structured log — the
    /// only channel a rejected command is reported on).
    pub(super) fn stderr_text(&self) -> String {
        crate::sync::lock_or_recover(&self.stderr).join("\n")
    }

    /// Poll the child's stderr until `needle` appears, or fail after `window`.
    pub(super) async fn wait_for_stderr(&self, needle: &str, window: Duration) {
        let deadline = tokio::time::Instant::now() + window;
        while tokio::time::Instant::now() < deadline {
            if self.stderr_text().contains(needle) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!(
            "the sidecar never logged {needle:?} within {window:?}; stderr:\n{}",
            self.stderr_text()
        );
    }
}

/// The wire `type` of a decoded event, for failure messages. Serializing back is
/// cheaper to maintain than a 47-arm match.
fn event_type_of(event: &NightcoreEvent) -> String {
    serde_json::to_value(event)
        .ok()
        .and_then(|v| v.get("type").and_then(Value::as_str).map(|s| s.to_string()))
        .unwrap_or_else(|| "<unserializable>".to_string())
}
