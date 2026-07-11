import { useEffect, useState } from 'react';

import { getUsage, onUsageEvent, type UsageMeter } from '@/lib/bridge';

/** A shell-level subscription to the shipped `nc:usage` snapshot (spec 2026-07-11):
 *  fetch on mount, then live-update from the meter's 10-min poll / focus refetch.
 *  This is the single source the usage-aware throttle's UI derives from — the board
 *  pause banner and the task-card manual-start chip both read the hottest window from
 *  this snapshot (the sidebar `UsageMeter` widget keeps its own richer view-model for
 *  the popover/cost; this is a thin read-only mirror so the derivation stays cheap).
 *
 *  Fail-soft: the bridge resolves a fallback meter off-Tauri and on any read error,
 *  so `meter` is simply the last-good snapshot (or `null` before the first fetch) —
 *  and a `null`/degraded meter derives to "cool" downstream (no banner, no chip). */
export function useUsageSnapshot(): { meter: UsageMeter | null } {
  const [meter, setMeter] = useState<UsageMeter | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;

    void getUsage()
      .then((next) => {
        if (!cancelled) setMeter(next);
      })
      .catch(() => {
        /* the bridge resolves a fallback; a rejection here is non-fatal */
      });

    void onUsageEvent((next) => setMeter(next))
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

  return { meter };
}
