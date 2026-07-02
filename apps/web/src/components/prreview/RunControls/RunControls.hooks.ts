/** Hook that owns the PR Review run-config state for the RunControls form. */
import { useCallback, useEffect, useState } from 'react';

import { listOpenPrs, type PrSummary, type ReviewLens } from '@/lib/bridge';
import { useRunConfig as useSharedRunConfig } from '@/lib/useRunConfig';

import { ALL_LENSES } from '../prreview.constants';
import type { PrReviewRunConfig } from './RunControls.types';

/** Parse a raw PR-number input into a positive integer, or `null` when the input
 *  is empty / non-numeric / not > 0. Digits-only so `1e3`, `-1`, `1.5`, and
 *  whitespace all reject. */
export function parsePrNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Own the PR Review run-config: the shared run-config (model/effort/lens
 * selection) plus the PR number. Instantiated by the PrReviewView hook (not by
 * `RunControls`) so the state lives ABOVE the form and survives the
 * CONFIGURE → RUNNING → RESULTS phase swaps and pre-fills on "New run".
 *
 * @param disabled when true (e.g. no active project), Review is never permitted.
 */
export interface OpenPrs {
  /** The active project's open pull requests, newest first. */
  prs: PrSummary[];
  /** True while the list is being (re)fetched. */
  loading: boolean;
  /** A fetch failure (gh missing / no remote / auth), or null. */
  error: string | null;
  /** Re-fetch the list. */
  refresh: () => void;
}

/**
 * Fetch the active project's open pull requests for the PR picker. Fetches on
 * mount (RunControls mounts only on the CONFIGURE screen, so the list is fresh
 * each time it appears) and on `refresh()`. A gh failure becomes `error` (the
 * picker surfaces it inline) — the typed-number escape hatch still works, so a
 * listing failure never blocks starting a review.
 */
export function useOpenPrs(): OpenPrs {
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const list = await listOpenPrs();
        if (!cancelled) setPrs(list);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setPrs([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  return { prs, loading, error, refresh };
}

export function useRunConfig(disabled: boolean): PrReviewRunConfig {
  const base = useSharedRunConfig<ReviewLens>(ALL_LENSES, disabled);
  const [prNumber, setPrNumber] = useState('');

  const prNumberValue = parsePrNumber(prNumber);
  const prNumberValid = prNumberValue !== null;

  return {
    ...base,
    prNumber,
    setPrNumber,
    prNumberValue,
    prNumberValid,
    canReview: base.canRun && prNumberValid,
    prefill: ({ prNumber: nextPr, model, categories }) => {
      if (nextPr != null) setPrNumber(String(nextPr));
      base.prefill({ model, categories });
    },
  };
}
