/** The web mirror of the Rust usage-throttle decision (spec 2026-07-11): a pure
 *  selector over the `nc:usage` snapshot + the threshold setting, plus a tiny
 *  context that carries the derived "hot window" to the task cards' advisory
 *  manual-start chip.
 *
 *  The selector is the SAME scan the Rust gate runs (§3.2): the run provider's row
 *  (claude in v1), `status === 'ok' && !stale`, ANY window at/above the threshold,
 *  the hottest one for the copy. It fails "cool" (returns `null`) on every uncertain
 *  branch — a disabled/degraded/stale meter never shows a chip or a banner, matching
 *  the backend's fail-open posture.
 *
 *  A plain-`.ts` feature-root module (like `chrome.ts` / `actions.ts`), so it renders
 *  its provider via `createElement` rather than JSX. */
import { createContext, createElement, type ReactNode, useContext } from 'react';

import type { UsageMeter } from '@/lib/bridge';

/** The provider the auto-loop's runs consume — pinned to Claude in v1 (decision 2),
 *  matching the Rust `RUN_PROVIDER_ID`. */
const RUN_PROVIDER_ID = 'claude';

/** The hottest rate-limit window at/above the throttle threshold on the run
 *  provider, when the meter is enabled + current — the input to both the board
 *  pause banner and the manual-start warning chip. */
export interface UsageHotWindow {
  /** The provider whose window is hot (`"claude"` in v1). */
  provider: string;
  /** The human window label (`"Session (5h)"`, `"Weekly"`, `"Opus weekly"`, …). */
  windowLabel: string;
  /** Utilization, normalized `0..=100` by the meter. */
  usedPercent: number;
  /** ISO-8601 reset instant, or `null` when the provider omits it. */
  resetsAt: string | null;
}

/** The hottest window at/above `threshold` on the run provider, or `null` when the
 *  meter is off/degraded/stale or no window is that hot. Pure — no subscription, no
 *  side effects — so the banner and the chip derive from one shared computation.
 *  Fail-cool at every branch (mirrors the Rust `hot_window`). */
export function hotUsageWindow(
  meter: UsageMeter | null,
  threshold: number,
): UsageHotWindow | null {
  if (meter === null) return null;
  const row = meter.providers.find((p) => p.provider === RUN_PROVIDER_ID);
  // Trust the number only when the row is Ok and not stale — every other status
  // (disabled / notConnected / rateLimited / unauthorized / unsupported / stale) is
  // a "do not trust as current" ⇒ no chip, no banner.
  if (row === undefined || row.status !== 'ok' || row.stale) return null;
  // ANY window at/above threshold (decision 2): scan ALL windows (never the compact
  // set, which drops model-scoped lanes); keep the hottest for the copy.
  let hottest: UsageHotWindow | null = null;
  for (const w of row.windows) {
    if (w.usedPercent < threshold) continue;
    if (hottest === null || w.usedPercent > hottest.usedPercent) {
      hottest = {
        provider: row.provider,
        windowLabel: w.label,
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt ?? null,
      };
    }
  }
  return hottest;
}

/** A display name for a provider id (`"claude"` → `"Claude"`) for the pause banner +
 *  chip copy. Mirrors the Rust `provider_display`; falls back to the raw id. */
export function providerDisplay(provider: string): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return provider;
}

/** Format an ISO reset instant as a short local clock (`~14:30`), or `null` when the
 *  provider omitted it / it doesn't parse — the banner then drops the "resumes ~…"
 *  clause. */
export function formatResetClock(resetsAt: string | null): string | null {
  if (resetsAt === null) return null;
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Carries the derived hot-window to the task cards' advisory manual-start chip.
 *  `null` = the meter is cool / off (no chip) — and, unlike the chrome/actions
 *  contexts, {@link useUsageHot} does NOT throw without a provider, so a card
 *  rendered in isolation (stories/tests) simply shows no chip. Low-churn: it changes
 *  only on a `nc:usage` snapshot or a threshold edit, never on a stream flush, so
 *  every memoized card can consume it without per-frame re-renders. */
const UsageHotContext = createContext<UsageHotWindow | null>(null);

/** Provide the derived hot-window to a subtree (the board's cards). */
export function UsageHotProvider({
  value,
  children,
}: {
  value: UsageHotWindow | null;
  children: ReactNode;
}) {
  return createElement(UsageHotContext.Provider, { value }, children);
}

/** Read the derived hot-window. `null` outside a provider (no chip) — advisory only,
 *  so a missing wiring degrades to "no chip", never a throw. */
export function useUsageHot(): UsageHotWindow | null {
  return useContext(UsageHotContext);
}
