/** The shared "is the provider usage meter opted in" signal (issue #305 fix).
 *
 *  Before this hook, the sidebar `UsageMeter` widget and the Settings → Usage
 *  toggle read two disconnected sources of truth: the widget derived `enabled`
 *  from its own live `nc:usage` snapshot, while the toggle read the load-once
 *  `settings.usageMeterEnabled` field and never re-read it. So enabling from the
 *  sidebar never updated the Settings switch, and disabling from Settings wasn't
 *  reflected in the sidebar until relaunch.
 *
 *  This hook is the shared seam: seeded from the persisted `settings.usageMeterEnabled`
 *  (correct at load time — Settings reads it from the same store the Rust commands
 *  flip), then kept live by the `nc:usage` subscription, which is now authoritative
 *  for every consumer — the `enable_usage_meter` / `disable_usage_meter` Tauri
 *  commands both push a fresh snapshot on that channel as soon as they change the
 *  state (not just on the next 10-minute poll), so a toggle fired from any surface
 *  reconciles every other mounted consumer of this hook. */
import { useCallback, useEffect, useState } from 'react';

import { disableUsageMeter, enableUsageMeter, onUsageEvent, type UsageMeter } from './bridge';

/** `true` when any provider row is out of the opt-in-off state — mirrors the Rust
 *  `disabled_meter()` shape (every row `disabled`) vs. any real (enabled) snapshot. */
export function isMeterEnabled(meter: UsageMeter): boolean {
  return meter.providers.some((row) => row.status !== 'disabled');
}

/** The shared enabled flag + toggle actions. */
export interface UsageMeterEnabledState {
  /** Whether the meter is currently opted in — seeded from settings at mount,
   *  authoritative from the live `nc:usage` snapshot afterwards. */
  enabled: boolean;
  /** Opt in: flips the persisted flag, fires the Keychain read, arms the poller. */
  enable: () => Promise<void>;
  /** Opt out: flips the flag off; the Rust poll loop parks. */
  disable: () => Promise<void>;
}

/** Reactive usage-meter enabled state, shared by every surface that renders a
 *  toggle for it (the Settings page, and — via the same underlying bridge calls —
 *  the sidebar widget's own opt-in gesture). `seedEnabled` is read only on mount;
 *  React ignores a `useState` initial argument on later renders, so a parent
 *  re-render with a different `seedEnabled` never stomps a value the live
 *  subscription has since corrected. */
export function useUsageMeterEnabled(seedEnabled: boolean): UsageMeterEnabledState {
  const [enabled, setEnabled] = useState(seedEnabled);

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;

    void onUsageEvent((meter) => {
      if (!cancelled) setEnabled(isMeterEnabled(meter));
    })
      .then((fn) => {
        if (cancelled) fn();
        else unsub = fn;
      })
      .catch(() => {
        /* registration failed (runtime not ready) — nothing to undo */
      });

    return () => {
      cancelled = true;
      if (unsub !== null) unsub();
    };
  }, []);

  const enable = useCallback(() => enableUsageMeter().then(() => setEnabled(true)), []);
  const disable = useCallback(() => disableUsageMeter().then(() => setEnabled(false)), []);

  return { enabled, enable, disable };
}
