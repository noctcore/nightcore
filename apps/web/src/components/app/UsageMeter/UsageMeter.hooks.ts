/** State seam + load lifecycle for the sidebar usage widget (issue #121). All
 *  bridge wiring lives behind the injectable {@link UsageSource} so the widget
 *  (`UsageMeter.tsx`) stays a thin presentation shell and stories drive every
 *  status without Tauri. */
import { useCallback, useEffect, useState } from 'react';

import {
  enableUsageMeter,
  getUsage,
  getUsageCost,
  onUsageEvent,
  type RateWindow,
  refreshUsage,
  type UsageMeter as UsageMeterSnapshot,
} from '@/lib/bridge';

import type { CostState, UsageSource } from './UsageMeter.types';

/** The live data seam — the real bridge commands + the `nc:usage` subscription.
 *  Stories/tests pass an in-memory {@link UsageSource} override so the widget
 *  renders (and every status is exercised) without Tauri. */
export const LIVE_USAGE_SOURCE: UsageSource = {
  getUsage,
  enable: enableUsageMeter,
  refresh: refreshUsage,
  getCost: getUsageCost,
  subscribe: onUsageEvent,
};

/** The widget's view-model: the current meter, whether it's opted-in (vs. showing
 *  the dormant "Enable" affordance), the enable gesture, and the per-provider
 *  detail-popover open + lazy-cost state. */
export interface UsageMeterView {
  /** The current snapshot, or `null` before the first fetch resolves (render
   *  nothing until then, so the footer never flashes a wrong state). */
  meter: UsageMeterSnapshot | null;
  /** `false` when the whole meter is opt-in-off — the widget shows its single
   *  "Enable usage meter" button (spec decision 5). */
  enabled: boolean;
  /** Opt in: fires the credential read (Keychain prompt) as a consequence of the
   *  click, then swaps in the returned first snapshot. */
  enable: () => void;
  /** The provider whose detail popover is open, or `null`. */
  openProvider: string | null;
  /** Toggle a provider's detail popover; opening it lazily fetches its cost. */
  toggleProvider: (provider: string) => void;
  /** Close whichever popover is open. */
  closePopover: () => void;
  /** The lazy cost-scan state for a provider (`idle` until its popover opens). */
  costFor: (provider: string) => CostState;
}

/** `true` when any provider row is out of the opt-in-off state — i.e. the meter is
 *  enabled and should render rows rather than the "Enable" button. An all-`disabled`
 *  meter (the `disabled_meter` shape) renders the opt-in affordance. */
function isMeterEnabled(meter: UsageMeterSnapshot): boolean {
  return meter.providers.some((row) => row.status !== 'disabled');
}

/** The compact-bar windows for a provider row: the session (`5h`) THEN the primary
 *  (non-model-scoped) `weekly` lane, in that order — the popover shows ALL windows
 *  incl. model-scoped. Picking the two canonical lanes explicitly (rather than the
 *  first two that happen to match) guarantees Claude's compact row shows 5h + weekly
 *  like Codex, and never lets an extra model-scoped weekly (`weekly_opus`, …) crowd
 *  out the session lane. Falls back to the first two windows only when neither
 *  canonical lane is present, so a future/unknown shape still renders something. */
export function compactWindows(windows: readonly RateWindow[]): RateWindow[] {
  const session = windows.find((w) => w.kind === '5h');
  const weekly = windows.find((w) => w.kind === 'weekly');
  const picked = [session, weekly].filter((w): w is RateWindow => w !== undefined);
  if (picked.length > 0) return picked;
  return windows.slice(0, 2);
}

/** Tailwind bar-fill class for a utilization percentage: calm under 60%, warning
 *  through 85%, destructive above — a glanceable "how close to the cap" signal. */
export function barTone(usedPercent: number): string {
  if (usedPercent >= 85) return 'bg-destructive';
  if (usedPercent >= 60) return 'bg-warning';
  return 'bg-success';
}

/** Drive the usage widget: fetch on mount, subscribe to `nc:usage`, refetch on
 *  window focus, own the enable gesture and the per-provider detail popover +
 *  lazy cost. */
export function useUsageMeter(source: UsageSource): UsageMeterView {
  const [meter, setMeter] = useState<UsageMeterSnapshot | null>(null);
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const [costByProvider, setCostByProvider] = useState<Record<string, CostState>>({});

  // Fetch-on-mount → live subscription → focus refetch. The unlisten is awaited
  // defensively (a StrictMode double-mount that resolves after unmount tears down
  // immediately), matching the bridge's `safeListen` teardown discipline.
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;

    void source
      .getUsage()
      .then((next) => {
        if (!cancelled) setMeter(next);
      })
      .catch(() => {
        /* the bridge resolves a fallback; a rejection here is non-fatal */
      });

    void source
      .subscribe((next) => setMeter(next))
      .then((fn) => {
        if (cancelled) fn();
        else unsub = fn;
      })
      .catch(() => {
        /* registration failed (runtime not ready) — nothing to undo */
      });

    const onFocus = (): void => {
      void source.refresh();
    };
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      if (unsub !== null) unsub();
      window.removeEventListener('focus', onFocus);
    };
  }, [source]);

  const enable = useCallback(() => {
    void source
      .enable()
      .then((next) => setMeter(next))
      .catch(() => {
        /* the enable command resolves a fallback; a rejection is non-fatal */
      });
  }, [source]);

  const closePopover = useCallback(() => setOpenProvider(null), []);

  const toggleProvider = useCallback(
    (provider: string) => {
      setOpenProvider((current) => (current === provider ? null : provider));
      // Lazily scan cost the first time a provider's popover opens (never on the
      // 10-min poll — spec §3.8). Re-open reuses the cached result.
      setCostByProvider((current) => {
        const existing = current[provider];
        if (existing !== undefined && existing.status !== 'error') return current;
        void source
          .getCost(provider)
          .then((cost) =>
            setCostByProvider((prev) => ({ ...prev, [provider]: { status: 'ready', cost } })),
          )
          .catch(() =>
            setCostByProvider((prev) => ({ ...prev, [provider]: { status: 'error' } })),
          );
        return { ...current, [provider]: { status: 'loading' } };
      });
    },
    [source],
  );

  const costFor = useCallback(
    (provider: string): CostState => costByProvider[provider] ?? { status: 'idle' },
    [costByProvider],
  );

  return {
    meter,
    enabled: meter !== null && isMeterEnabled(meter),
    enable,
    openProvider,
    toggleProvider,
    closePopover,
    costFor,
  };
}
