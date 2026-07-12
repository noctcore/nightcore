//! Process-wide logging (M4.5 §B).
//!
//! Two sinks from one `tracing` framework, initialized once at setup:
//!   - a **colored** human console layer (ANSI on) for `tauri dev`, and
//!   - a **plain** daily-rolling file layer (ANSI off) under Tauri's
//!     `app_log_dir()`, so a bundled app launched from Finder (no terminal) still
//!     leaves a diagnostic trail.
//!
//! Both layers emit span **close** events (`FmtSpan::CLOSE`), so the run-lifecycle
//! `#[instrument]` spans (`run.launch` / `run.build_completed` / `run.review_completed`)
//! surface their wall-clock latency as first-class structured `time.busy`/`time.idle`
//! durations rather than being reconstructed from one-off `duration_ms` fields.
//!
//! The file appender is non-blocking; its [`WorkerGuard`] must outlive the app or
//! buffered lines are dropped on exit, so [`init`] returns it and `lib.rs` parks it
//! in managed state for the process lifetime.
//!
//! Level: `RUST_LOG` wins when set (the developer env override); otherwise the
//! persisted [`LogLevel`] settings knob drives it, applied at startup and reloaded
//! live whenever the setting is patched via a [`reload::Handle`] parked in managed
//! state ([`LogReloadHandle`]). All diagnostics flow through the `tracing` macros
//! (`error!`/`warn!`/`info!`/`debug!`) with structured `task_id`/`session_id` fields —
//! never `eprintln!`.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::fmt::format::FmtSpan;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, reload, EnvFilter, Registry};
#[cfg(test)]
use ts_rs::TS;

/// The user-facing log verbosity vocabulary, ordered most-quiet to most-verbose and
/// mapping 1:1 onto the five `tracing` levels. Persisted as a free string in
/// `Settings` (fail-safe, like `permission_mode`); this enum exists to (a) drive the
/// Rust→TS codegen so the Settings picker type-checks against
/// `'error' | 'warn' | 'info' | 'debug' | 'trace'`, and (b) map a stored string to an
/// [`EnvFilter`] directive for the runtime reload. `#[serde(rename_all = "lowercase")]`
/// is the wire form the web and `settings.json` speak.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, ts(export, export_to = "LogLevel.ts"))]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    /// Fail-safe parse of a persisted settings string. An unrecognized/legacy value
    /// resolves to `Info` (the shipped default) so a hand-edited or stale settings
    /// value can never build an invalid filter or wedge logging.
    pub fn from_settings(raw: &str) -> Self {
        match raw {
            "error" => LogLevel::Error,
            "warn" => LogLevel::Warn,
            "debug" => LogLevel::Debug,
            "trace" => LogLevel::Trace,
            // "info" and any unrecognized/legacy value → the default.
            _ => LogLevel::Info,
        }
    }

    /// The [`EnvFilter`] directive for this level — a bare global level the same way
    /// [`init`]'s `EnvFilter::new("info")` fallback is a global level.
    pub fn directive(self) -> &'static str {
        match self {
            LogLevel::Error => "error",
            LogLevel::Warn => "warn",
            LogLevel::Info => "info",
            LogLevel::Debug => "debug",
            LogLevel::Trace => "trace",
        }
    }
}

/// Holds the file appender's flush guard alive for the whole app lifetime. Parked
/// in managed Tauri state by `lib.rs` setup. Dropping it flushes and stops the
/// background writer, so it must never be dropped before exit.
pub struct LogGuard(#[allow(dead_code)] WorkerGuard);

/// A handle to the global `EnvFilter`, parked in managed Tauri state so a settings
/// patch can change log verbosity live (no restart). Cheap to clone (Arc-backed
/// inside `tracing`); `Send + Sync` so it lives in managed state.
pub struct LogReloadHandle {
    handle: reload::Handle<EnvFilter, Registry>,
    /// `RUST_LOG` pinned the filter at startup — the developer env override wins, so
    /// the settings knob defers to it and never reloads the filter.
    env_pinned: bool,
}

impl LogReloadHandle {
    /// Apply a persisted [`LogLevel`] string to the live subscriber. A no-op when
    /// `RUST_LOG` pinned the level (the env override wins) or when the filter rebuild
    /// fails (logged, but never propagated — a failed verbosity change must not break
    /// a settings save). Idempotent: re-applying the current level is harmless.
    pub fn apply(&self, raw: &str) {
        if self.env_pinned {
            tracing::debug!(target: "nightcore", "RUST_LOG is set; ignoring the logLevel setting");
            return;
        }
        let level = LogLevel::from_settings(raw);
        match self.handle.reload(EnvFilter::new(level.directive())) {
            Ok(()) => {
                tracing::info!(target: "nightcore", log_level = level.directive(), "log level updated")
            }
            Err(e) => {
                tracing::warn!(target: "nightcore", error = %e, "failed to reload the tracing filter")
            }
        }
    }
}

/// Initialize the global tracing subscriber: a colored console layer plus a plain
/// daily-rolling file layer in `app_log_dir()/nightcore.log`, both emitting span
/// close events so lifecycle span durations are logged. Idempotent-safe to call once
/// at setup; a second init is rejected by `tracing` and ignored. Returns the file
/// appender guard (keep alive for the process lifetime) and the [`LogReloadHandle`]
/// (park in managed state) so the persisted `logLevel` can be applied at startup and
/// reloaded on patch.
pub fn init(app: &AppHandle) -> (LogGuard, LogReloadHandle) {
    // Level from RUST_LOG, else info. `EnvFilter` parses targets too, so a
    // developer can do e.g. `RUST_LOG=nightcore_lib=debug,sidecar=info`. When
    // RUST_LOG is set it PINS the level: the settings knob then defers to it so a
    // developer's env override is never silently overwritten by a stored setting.
    let env_pinned = std::env::var("RUST_LOG").is_ok();
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    // Wrap the filter in a reload layer so the `logLevel` setting can swap it live.
    let (filter, reload_handle) = reload::Layer::new(filter);

    let log_dir = app.path().app_log_dir().expect("app log dir unavailable");
    let _ = std::fs::create_dir_all(&log_dir);

    let file_appender = tracing_appender::rolling::daily(&log_dir, "nightcore.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);

    // Console: colored, compact, with target + fields. File: plain (no ANSI) so the
    // captured/persisted form stays grep-clean and parseable. Both log span CLOSE
    // events so an `#[instrument]` lifecycle span emits its wall-clock
    // `time.busy`/`time.idle` on completion — latency as a first-class structured
    // duration, not reconstructed from ad-hoc `duration_ms` fields.
    let console_layer = fmt::layer()
        .with_ansi(true)
        .with_target(true)
        .with_span_events(FmtSpan::CLOSE)
        .compact();
    let file_layer = fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_span_events(FmtSpan::CLOSE)
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

    (
        LogGuard(guard),
        LogReloadHandle {
            handle: reload_handle,
            env_pinned,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_settings_maps_known_levels_and_is_fail_safe() {
        assert_eq!(LogLevel::from_settings("error"), LogLevel::Error);
        assert_eq!(LogLevel::from_settings("warn"), LogLevel::Warn);
        assert_eq!(LogLevel::from_settings("info"), LogLevel::Info);
        assert_eq!(LogLevel::from_settings("debug"), LogLevel::Debug);
        assert_eq!(LogLevel::from_settings("trace"), LogLevel::Trace);
        // Unknown / legacy / empty → the shipped default, never an error.
        assert_eq!(LogLevel::from_settings("silent"), LogLevel::Info);
        assert_eq!(LogLevel::from_settings("verbose"), LogLevel::Info);
        assert_eq!(LogLevel::from_settings(""), LogLevel::Info);
    }

    #[test]
    fn every_directive_builds_a_valid_env_filter() {
        // The reload path feeds `directive()` straight into `EnvFilter::new` — prove
        // every level (and a fail-safe fallback) yields a parseable directive so a
        // reload can never panic on a malformed filter.
        for raw in ["error", "warn", "info", "debug", "trace", "garbage", ""] {
            let directive = LogLevel::from_settings(raw).directive();
            // Constructing the filter is what the live reload does; it must not panic.
            let _filter = EnvFilter::new(directive);
        }
    }

    #[test]
    fn directive_round_trips_through_from_settings() {
        // `directive()` is the inverse of `from_settings` for the canonical strings,
        // so a stored value and its applied filter never drift.
        for level in [
            LogLevel::Error,
            LogLevel::Warn,
            LogLevel::Info,
            LogLevel::Debug,
            LogLevel::Trace,
        ] {
            assert_eq!(LogLevel::from_settings(level.directive()), level);
        }
    }
}
