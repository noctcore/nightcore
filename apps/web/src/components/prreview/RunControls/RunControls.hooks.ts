/** Hook that owns the PR Review run-config state for the RunControls form. */
import { useState } from 'react';

import type { ReviewLens } from '@/lib/bridge';
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
