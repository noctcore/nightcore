/** Fetch state for the PR Review workspace status block: `pr_status_by_number`
 *  on selection + manual refresh only (NO polling) — the by-number sibling of
 *  the board card's `usePrStatus`. */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { PrStatus } from '@/lib/bridge';
import { prStatusByNumber } from '@/lib/bridge';

import type { PrNumberStatusView } from './PrStatusBlock.types';

/** Coerce a thrown value (Tauri rejections are commonly plain strings) into a
 *  readable inline-error line. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Fetch the live status of PR `prNumber` on selection change and on demand.
 * `override` is the story/test seam — when provided (including `null`) no
 * fetch ever fires. `enabled=false` renders the inert empty view and fetches
 * nothing — the OWNER lifts this hook into the PrReviewView model (so the
 * workspace status line + review-position banners share the fetched state), and
 * a null selection must not fetch. Switching PRs resets the snapshot
 * synchronously BEFORE paint (the render-adjust pattern the board card uses) so
 * PR A's status can never render one stale frame against PR B.
 */
export function usePrStatusByNumber(
  prNumber: number,
  override?: PrStatus | null,
  enabled: boolean = true,
): PrNumberStatusView {
  const skip = override !== undefined || !enabled;
  // A fetch is about to start whenever a real PR is selected — seeding
  // `fetching` from that (instead of `false` + the effect's later set) removes
  // the one-frame "not loaded yet" flash before the fetch effect runs.
  const willFetch = !skip && prNumber > 0;
  const [status, setStatus] = useState<PrStatus | null>(null);
  const [fetching, setFetching] = useState(willFetch);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  // Bumping the epoch re-runs the fetch effect (the manual refresh).
  const [epoch, setEpoch] = useState(0);

  // PR-switch reset, synchronously before paint — including `fetching`, so the
  // switched-to PR paints its fetch state immediately (no flash frame).
  const [lastPr, setLastPr] = useState(prNumber);
  if (lastPr !== prNumber) {
    setLastPr(prNumber);
    setStatus(null);
    setFetching(willFetch);
    setError(null);
    setUnavailable(false);
    setRefreshedAt(null);
  }

  useEffect(() => {
    if (skip || prNumber <= 0) return;
    let stale = false;
    setFetching(true);
    setError(null);
    prStatusByNumber(prNumber).then(
      (next) => {
        if (stale) return;
        // Coerce a void resolution (mock/browser seams) to the null sentinel.
        const value = next ?? null;
        setStatus(value);
        setUnavailable(value === null);
        setRefreshedAt(Date.now());
        setFetching(false);
      },
      (err: unknown) => {
        if (stale) return;
        // Error surfaced via returned `error` state (UI displays it); no direct console.
        setError(errorText(err));
        setFetching(false);
      },
    );
    return () => {
      stale = true;
    };
  }, [skip, prNumber, epoch]);

  const refresh = useCallback(() => setEpoch((n) => n + 1), []);

  return useMemo<PrNumberStatusView>(() => {
    if (override !== undefined) {
      return {
        status: override,
        fetching: false,
        error: null,
        unavailable: override === null,
        refreshedAt: null,
        refresh,
      };
    }
    if (!enabled) {
      return {
        status: null,
        fetching: false,
        error: null,
        unavailable: false,
        refreshedAt: null,
        refresh,
      };
    }
    return { status, fetching, error, unavailable, refreshedAt, refresh };
  }, [override, enabled, status, fetching, error, unavailable, refreshedAt, refresh]);
}
