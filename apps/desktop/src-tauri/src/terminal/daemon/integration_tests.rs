//! Headless integration tests for the detached-PTY-daemon IPC (cockpit spec PR 6,
//! §8): a real `Server` on a real Unix socket, driven by a real `DaemonClient`
//! through create → write → detach → reattach → replay → kill. Unix + test only.
//!
//! The production process-detach (`setsid` re-invoke of the app exe) can't be
//! exercised in the shared test binary — re-invoking `current_exe` would re-run the
//! test harness — so it is dogfood-verified (§8) while everything reachable in-process
//! (the protocol, session ownership, the sequence-numbered replay, reattach takeover)
//! is covered here against a thread-hosted server.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tempfile::TempDir;

use super::client::DaemonClient;
use super::server::test_support::TestDaemon;
use crate::terminal::OutputSink;

/// A sink that accumulates every output batch, pollable for a marker.
fn accumulating_sink() -> (OutputSink, Arc<Mutex<Vec<u8>>>) {
    let acc = Arc::new(Mutex::new(Vec::<u8>::new()));
    let acc2 = Arc::clone(&acc);
    let sink: OutputSink = Box::new(move |bytes| {
        if let Ok(mut buf) = acc2.lock() {
            buf.extend_from_slice(&bytes);
        }
    });
    (sink, acc)
}

/// Poll `acc` until `needle` appears or the deadline passes; returns whether it did.
fn wait_for(acc: &Arc<Mutex<Vec<u8>>>, needle: &[u8]) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if acc
            .lock()
            .map(|b| b.windows(needle.len()).any(|w| w == needle))
            .unwrap_or(false)
        {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// A short unique socket path under the per-user 0700 dir (kept short for `sun_path`).
fn socket_for(persist: &std::path::Path) -> std::path::PathBuf {
    super::socket_path(persist).expect("derive a socket path")
}

#[test]
fn full_lifecycle_create_write_detach_reattach_replay_kill() {
    let tmp = TempDir::new().unwrap();
    let persist = tmp.path().join("terminals");
    let socket = socket_for(&persist);
    let daemon = TestDaemon::start(socket.clone(), persist.clone());

    // --- Connect + create a live session -----------------------------------
    let (client, sessions) = DaemonClient::connect(&daemon.socket).expect("connect");
    assert!(sessions.is_empty(), "a fresh daemon owns no sessions");

    let (sink, acc) = accumulating_sink();
    let info = client
        .create(tmp.path().to_string_lossy().into_owned(), 80, 24, sink)
        .expect("create a daemon session");
    assert!(info.alive);
    assert!(
        !info.confined,
        "daemon sessions are always unconfined (§5.5)"
    );

    // --- Write; the marker echoes back through the fanout ------------------
    client
        .write(&info.id, b"printf DAEMON_ONE\\n\n")
        .expect("write to the session");
    assert!(
        wait_for(&acc, b"DAEMON_ONE"),
        "the first client sees its output live"
    );

    // The session shows up in a fresh list.
    assert!(client.list().iter().any(|s| s.id == info.id));

    // --- Detach: drop the client (the app "closed"). The session lives on. -
    drop(client);
    std::thread::sleep(Duration::from_millis(200));

    // --- Reattach with a NEW client (relaunch): the session is still live --
    let (client2, sessions2) = DaemonClient::connect(&daemon.socket).expect("reconnect");
    assert!(
        sessions2.iter().any(|s| s.id == info.id),
        "the survived session is reported to the reattaching app"
    );

    let (sink2, acc2) = accumulating_sink();
    // since_seq = 0 → replay the whole retained ring, exactly like a fresh xterm.
    client2
        .attach(&info.id, 0, sink2)
        .expect("reattach to the survived session");
    assert!(
        wait_for(&acc2, b"DAEMON_ONE"),
        "the reattaching client replays the buffered output tail (§5.3)"
    );

    // --- Still live after reattach: a second write streams to the new sink -
    client2
        .write(&info.id, b"printf DAEMON_TWO\\n\n")
        .expect("write after reattach");
    assert!(
        wait_for(&acc2, b"DAEMON_TWO"),
        "live output flows to the reattached client"
    );

    // --- Kill: the session drops from the daemon's list --------------------
    client2.kill(&info.id).expect("kill");
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && client2.list().iter().any(|s| s.id == info.id) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !client2.list().iter().any(|s| s.id == info.id),
        "a killed session leaves the daemon's list"
    );
}

#[test]
fn write_to_an_unknown_session_errors_but_keeps_the_connection() {
    let tmp = TempDir::new().unwrap();
    let persist = tmp.path().join("terminals");
    let socket = socket_for(&persist);
    let daemon = TestDaemon::start(socket.clone(), persist);
    let (client, _) = DaemonClient::connect(&daemon.socket).expect("connect");

    assert!(
        client.write("ghost", b"x").is_err(),
        "an unknown id is an error"
    );
    // The connection survives the error: a subsequent list still works.
    assert!(client.is_alive());
    assert!(client.list().is_empty());
}

#[test]
fn a_refused_connection_surfaces_as_an_error() {
    // No daemon at this path: connect must fail (the backend then spawns one / degrades).
    let tmp = TempDir::new().unwrap();
    let socket = tmp.path().join("absent.sock");
    assert!(DaemonClient::connect(&socket).is_err());
}

#[test]
fn a_peer_with_the_owning_uid_is_served() {
    // The peer-cred happy path (§5.2, PR D): the daemon serves OUR uid (the production
    // default), so the same-process handshake completes and lists zero sessions. This
    // and `full_lifecycle_…` both go through the real `SO_PEERCRED`/`getpeereid` accept
    // gate — a same-uid peer is always let through.
    let tmp = TempDir::new().unwrap();
    let persist = tmp.path().join("terminals");
    let socket = socket_for(&persist);
    let _daemon = TestDaemon::start_as(socket.clone(), persist, super::discovery::euid());
    let (client, sessions) =
        DaemonClient::connect(&socket).expect("a same-uid peer is served the handshake");
    assert!(sessions.is_empty(), "a fresh daemon owns no sessions");
    assert!(client.is_alive());
}

#[test]
fn a_peer_with_a_mismatched_uid_is_refused() {
    // The peer-cred reject path (§5.2, PR D): the daemon is told to serve a uid that is
    // NOT ours, so our same-process connection — which the kernel reports at OUR euid —
    // fails the uid check and is dropped at accept, BEFORE the handshake. The client's
    // `connect` therefore errors (the backend then degrades to the in-process PTY).
    // Simulating the mismatch via the injected expected uid exercises the real
    // getsockopt/getpeereid path without needing a second OS user.
    let tmp = TempDir::new().unwrap();
    let persist = tmp.path().join("terminals");
    let socket = socket_for(&persist);
    let not_our_uid = super::discovery::euid().wrapping_add(1);
    let _daemon = TestDaemon::start_as(socket.clone(), persist, not_our_uid);
    assert!(
        DaemonClient::connect(&socket).is_err(),
        "a connection whose peer uid differs from the daemon's is refused, not served"
    );
}
