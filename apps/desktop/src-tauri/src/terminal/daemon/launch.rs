//! The `--terminal-daemon` argv dispatch (cockpit spec PR 6): when THIS process was
//! re-invoked as the detached daemon, parse its args and run the server (never
//! returning); otherwise return so normal app boot continues. Kept out of `mod.rs`
//! (a manifest) per the module-shape rule.

/// If this process was re-invoked as the detached PTY daemon (`--terminal-daemon`),
/// run the daemon server and NEVER return (it `process::exit`s). Otherwise return so
/// normal app boot continues. Called first thing in `run()`, before any Tauri setup.
pub fn maybe_run_daemon() {
    if !std::env::args().any(|a| a == "--terminal-daemon") {
        return;
    }
    #[cfg(unix)]
    {
        let args = parse_daemon_args();
        super::server::run(args.socket, args.persist_dir, args.idle_secs);
    }
    #[cfg(not(unix))]
    {
        // The app never spawns a daemon on an unsupported platform, so this arg
        // should never appear here — but fail loudly rather than boot a half GUI.
        eprintln!("nightcore: --terminal-daemon is unsupported on this platform");
        std::process::exit(1);
    }
}

#[cfg(unix)]
struct DaemonArgs {
    socket: std::path::PathBuf,
    persist_dir: std::path::PathBuf,
    idle_secs: u64,
}

/// Parse the `--terminal-daemon --socket <p> --persist-dir <p> --idle-secs <n>` argv
/// the launcher passed. Missing paths are a fatal misconfiguration (exit); a missing
/// idle value falls back to the default grace.
#[cfg(unix)]
fn parse_daemon_args() -> DaemonArgs {
    use std::path::PathBuf;
    let mut socket: Option<PathBuf> = None;
    let mut persist_dir: Option<PathBuf> = None;
    let mut idle_secs = super::DEFAULT_IDLE_GRACE_SECS;
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--socket" => socket = args.next().map(PathBuf::from),
            "--persist-dir" => persist_dir = args.next().map(PathBuf::from),
            "--idle-secs" => {
                if let Some(v) = args.next().and_then(|v| v.parse().ok()) {
                    idle_secs = v;
                }
            }
            _ => {}
        }
    }
    match (socket, persist_dir) {
        (Some(socket), Some(persist_dir)) => DaemonArgs {
            socket,
            persist_dir,
            idle_secs,
        },
        _ => {
            eprintln!("nightcore daemon: --socket and --persist-dir are required");
            std::process::exit(2);
        }
    }
}
