//! The 10-minute single-flight poll loop (spec §3.3), mirroring the auto-loop's
//! spawn+select tick driver (`orchestration::coordinator::auto_loop`).
//!
//! The loop is spawned via `tauri::async_runtime::spawn` (NOT bare `tokio::spawn`,
//! which panics with no runtime — the tested auto-loop regression). It is armed on
//! enable + on startup if already enabled; a disabled meter PARKS on the enable
//! kick, spending zero CPU/network. Each batch is naturally single-flight (the loop
//! is sequential); a kick that lands mid-poll is coalesced by `Notify::notify_one`
//! into at most one follow-up batch, never a stacked concurrent poll.

use std::future::Future;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::settings::SettingsStore;
use crate::usage::contract::UsageMeter;
use crate::usage::http::{build_client, FetchError, ParsedUsage};
use crate::usage::registry::{UsageRegistry, PROVIDERS};
use crate::usage::{claude, codex};

/// The `nc:usage` push channel (spec §3.9). Single-sourced from the
/// `@nightcore/contracts` `CHANNELS` registry — the `contracts::mod` conformance
/// test asserts this const equals `NIGHTCORE_CHANNELS.usage`, so a rename on either
/// tier fails `cargo test`.
pub(crate) const USAGE_EVENT: &str = "nc:usage";

/// Fixed 10-minute cadence (spec decision 4 — 10, not CodexBar's 5).
const POLL_INTERVAL: Duration = Duration::from_secs(600);

/// The staleness threshold the focus-refresh guard uses: a `refresh_usage` kick only
/// fires a poll when the snapshot is at least this old (spec §3.3).
pub(crate) const REFRESH_MIN_AGE: Duration = POLL_INTERVAL;

/// Arm the poll loop (idempotent). Spawns the background task on first arm; a second
/// call just nudges a poll. Called from `lib.rs` setup when the flag is already on,
/// and from `enable_usage_meter`.
pub(crate) fn arm(app: &AppHandle) {
    let reg = app.state::<UsageRegistry>();
    if !reg.try_arm() {
        reg.notify();
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { run_loop(app).await });
}

/// Wake the loop (enable / disable / focus-refresh). No-op if the registry isn't
/// managed yet.
pub(crate) fn kick(app: &AppHandle) {
    if let Some(reg) = app.try_state::<UsageRegistry>() {
        reg.notify();
    }
}

/// The loop: park on the enable kick while disabled; poll then wait (kick or 10-min
/// tick) while enabled.
async fn run_loop(app: AppHandle) {
    loop {
        if !enabled(&app) {
            // Parked — zero network while opt-in-off (spec decision 5). `disable`
            // notifies so a running loop re-checks and parks here promptly.
            app.state::<UsageRegistry>().kick().notified().await;
            continue;
        }
        poll_once(&app).await;
        let reg = app.state::<UsageRegistry>();
        let kicked = reg.kick().notified();
        tokio::select! {
            _ = kicked => {}
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
        }
    }
}

/// One poll batch: build the client, fetch every non-cooldown provider, emit the
/// updated snapshot over `nc:usage`. A client-build failure skips the batch (keeps
/// last-good) rather than panicking.
///
/// Re-checks `enabled` right before emitting (issue #305): a `disable_usage_meter`
/// call landing mid-batch already pushed its OWN `disabled_meter()` snapshot, but
/// doesn't cancel this in-flight batch — without the re-check, this emit would land
/// after that one and show a since-disabled meter as live again until the next tick.
async fn poll_once(app: &AppHandle) {
    let client = match build_client() {
        Ok(c) => c,
        Err(_) => return,
    };
    let reg = app.state::<UsageRegistry>();
    poll_batch(reg.inner(), |provider| dispatch_fetch(&client, provider)).await;
    let _ = app.emit(USAGE_EVENT, state_change_snapshot(&reg, enabled(app)));
}

/// The snapshot to push on `nc:usage` for a given enabled state (issue #305): the
/// real last-good registry snapshot when enabled, else the synthesized `disabled`
/// shape — regardless of what the registry still holds from before the meter was
/// turned off. Pure over the registry + a bool (no `AppHandle`), so it's the one
/// piece of `poll_once`'s new race-guard that's unit-testable; `commands::usage`'s
/// `enable`/`disable_usage_meter` push the same two shapes directly (one hardcoded
/// branch each — no decision to make there).
fn state_change_snapshot(reg: &UsageRegistry, enabled: bool) -> UsageMeter {
    if enabled {
        reg.snapshot()
    } else {
        UsageRegistry::disabled_meter()
    }
}

/// The pure-over-an-injected-fetch batch (spec §3.3): each provider not in a 429
/// cooldown is fetched and its result mapped onto the fail-soft state machine. Unit-
/// tested with an injected fetch fn (no live network).
pub(crate) async fn poll_batch<F, Fut>(reg: &UsageRegistry, fetch: F)
where
    F: Fn(&'static str) -> Fut,
    Fut: Future<Output = Result<ParsedUsage, FetchError>>,
{
    for &provider in PROVIDERS {
        if reg.in_cooldown(provider) {
            continue; // stays RateLimited with its last-good windows (spec decision 4)
        }
        match fetch(provider).await {
            Ok(parsed) => reg.mark_ok(provider, parsed),
            Err(err) => reg.apply_error(provider, err),
        }
    }
}

/// Fetch one provider's usage over the shared client (the only place that names a
/// provider → fetcher mapping).
async fn dispatch_fetch(
    client: &reqwest::Client,
    provider: &str,
) -> Result<ParsedUsage, FetchError> {
    match provider {
        "claude" => claude::fetch(client).await,
        "codex" => codex::fetch(client).await,
        _ => Err(FetchError::NoCreds),
    }
}

/// Whether the meter is opt-in-on (spec decision 5). `false` when the settings store
/// isn't managed yet (startup ordering safety).
fn enabled(app: &AppHandle) -> bool {
    app.try_state::<SettingsStore>()
        .map(|s| s.with_settings(|s| s.usage_meter_enabled))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::contract::UsageStatus;

    fn row_status(reg: &UsageRegistry, provider: &str) -> UsageStatus {
        reg.snapshot()
            .providers
            .into_iter()
            .find(|r| r.provider == provider)
            .expect("provider row")
            .status
    }

    #[test]
    fn poll_batch_applies_ok_and_error_per_provider() {
        let reg = UsageRegistry::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            // claude succeeds; codex is unauthorized — one bad provider never sinks
            // the other (spec §3.6).
            poll_batch(&reg, |provider| async move {
                match provider {
                    "claude" => Ok(ParsedUsage::default()),
                    _ => Err(FetchError::Unauthorized),
                }
            })
            .await;
        });
        assert_eq!(row_status(&reg, "claude"), UsageStatus::Ok);
        assert_eq!(row_status(&reg, "codex"), UsageStatus::Unauthorized);
    }

    #[test]
    fn poll_batch_skips_a_provider_in_cooldown_keeping_last_good() {
        let reg = UsageRegistry::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            // First batch: claude gets fresh windows then a 429 (→ cooldown).
            poll_batch(&reg, |provider| async move {
                match provider {
                    "claude" => Ok(ParsedUsage {
                        windows: vec![crate::usage::contract::RateWindow {
                            kind: "5h".into(),
                            label: "Session (5h)".into(),
                            used_percent: 10.0,
                            resets_at: None,
                            window_seconds: None,
                            scope_model: None,
                        }],
                        credits: None,
                    }),
                    _ => Err(FetchError::NoCreds),
                }
            })
            .await;
            poll_batch(&reg, |provider| async move {
                match provider {
                    "claude" => Err(FetchError::RateLimited {
                        retry_after: Some(Duration::from_secs(300)),
                    }),
                    _ => Err(FetchError::NoCreds),
                }
            })
            .await;

            // Second batch: claude is now in cooldown — a fetch that WOULD panic must
            // never be called for it (proving the skip).
            poll_batch(&reg, |provider| async move {
                if provider == "claude" {
                    panic!("a provider in cooldown must not be fetched");
                }
                Err(FetchError::NoCreds)
            })
            .await;
        });
        assert_eq!(row_status(&reg, "claude"), UsageStatus::RateLimited);
        let claude = reg
            .snapshot()
            .providers
            .into_iter()
            .find(|r| r.provider == "claude")
            .unwrap();
        assert_eq!(
            claude.windows.len(),
            1,
            "last-good windows survive the cooldown"
        );
    }

    #[test]
    fn state_change_snapshot_is_the_disabled_shape_when_off() {
        // A disable landing mid-poll must win over whatever the registry still holds
        // from before the meter was turned off (issue #305 race guard).
        let reg = UsageRegistry::new();
        reg.mark_ok("claude", ParsedUsage::default());
        let snapshot = state_change_snapshot(&reg, false);
        assert!(snapshot
            .providers
            .iter()
            .all(|r| r.status == UsageStatus::Disabled));
    }

    #[test]
    fn state_change_snapshot_is_the_real_registry_snapshot_when_on() {
        let reg = UsageRegistry::new();
        reg.mark_ok("claude", ParsedUsage::default());
        assert_eq!(state_change_snapshot(&reg, true), reg.snapshot());
    }
}
