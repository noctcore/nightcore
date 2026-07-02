/** Filter + manual-entry state for the PR Review pull-request picker. */
import { useMemo, useState } from 'react';

import type { PrSummary } from '@/lib/bridge';

import { parsePrNumber } from '../RunControls';
import type { PrPickerRow } from './PrPicker.types';

export interface UsePrPicker {
  /** The filter box text (also the manual-number entry). */
  query: string;
  setQuery: (value: string) => void;
  /** The open PRs matching the filter, each marked selected/not. */
  rows: PrPickerRow[];
  /** A valid positive PR number typed into the filter that is NOT in the open
   *  list — the "review PR #N anyway" escape hatch (closed/old/beyond the cap).
   *  Null when the query is empty, non-numeric, or already an open PR. */
  manualNumber: number | null;
  /** True when the filter box has text (drives the "no matches" copy). */
  hasQuery: boolean;
}

/** Filter the open-PR list by number/title/branch/author (case-insensitive) and
 *  derive the manual-number escape hatch. The filter box doubles as the manual PR
 *  entry — the `BranchPicker` "input is also the create affordance" pattern. */
export function usePrPicker(prs: PrSummary[], value: number | null): UsePrPicker {
  const [query, setQuery] = useState('');

  const { rows, manualNumber } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched: PrPickerRow[] = prs
      .filter(
        (pr) =>
          q === '' ||
          String(pr.number).includes(q) ||
          pr.title.toLowerCase().includes(q) ||
          pr.headRefName.toLowerCase().includes(q) ||
          pr.author.toLowerCase().includes(q),
      )
      .map((pr) => ({ pr, selected: pr.number === value }));

    const typed = parsePrNumber(query);
    const manual =
      typed !== null && !prs.some((pr) => pr.number === typed) ? typed : null;

    return { rows: matched, manualNumber: manual };
  }, [prs, value, query]);

  return { query, setQuery, rows, manualNumber, hasQuery: query.trim() !== '' };
}
