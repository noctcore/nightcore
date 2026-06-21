//! Process-wide logging (M4.5 §B).
//!
//! Two sinks from one `tracing` framework, initialized once at setup:
//!   - a **colored** human console layer (ANSI on) for `tauri dev`, and
//!   - a **plain** daily-rolling file layer (ANSI off) under Tauri's
//!     `app_log_dir()`, so a bundled app launched from Finder (no terminal) still
//!     leaves a diagnostic trail.
//!
//! The file appender is non-blocking; its [`WorkerGuard`] must outlive the app or
//! buffered lines are dropped on exit, so [`init`] returns it and `lib.rs` parks it
//! in managed state for the process lifetime.
//!
//! Level comes from `RUST_LOG` when set, else `info` (a `logLevel` settings knob is
//! P2). All diagnostics flow through the `tracing` macros (`error!`/`warn!`/`info!`/
//! `debug!`) with structured `task_id`/`session_id` fields — never `eprintln!`.

use tauri::{AppHandle, Manager};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter};

/// Holds the file appender's flush guard alive for the whole app lifetime. Parked
/// in managed Tauri state by `lib.rs` setup. Dropping it flushes and stops the
/// background writer, so it must never be dropped before exit.
pub struct LogGuard(#[allow(dead_code)] WorkerGuard);

/// Initialize the global tracing subscriber: a colored console layer plus a plain
/// daily-rolling file layer in `app_log_dir()/nightcore.log`. Idempotent-safe to
/// call once at setup; a second init is rejected by `tracing` and ignored. Returns
/// the file appender guard for the caller to keep alive.
pub fn init(app: &AppHandle) -> LogGuard {
    // Level from RUST_LOG, else info. `EnvFilter` parses targets too, so a
    // developer can do e.g. `RUST_LOG=nightcore_lib=debug,sidecar=info`.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    let log_dir = app
        .path()
        .app_log_dir()
        .expect("app log dir unavailable");
    let _ = std::fs::create_dir_all(&log_dir);

    let file_appender = tracing_appender::rolling::daily(&log_dir, "nightcore.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);

    // Console: colored, compact, with target + fields. File: plain (no ANSI) so the
    // captured/persisted form stays grep-clean and parseable.
    let console_layer = fmt::layer()
        .with_ansi(true)
        .with_target(true)
        .compact();
    let file_layer = fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_writer(file_writer);

    // `try_init` so a duplicate init (e.g. a test harness) doesn't panic the app.
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(console_layer)
        .with(file_layer)
        .try_init();

    tracing::info!(
        target: "nightcore",
        log_dir = %log_dir.display(),
        "logging initialized"
    );

    LogGuard(guard)
}
