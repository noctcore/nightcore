/** Filter + manual-entry state for the PR Review pull-request picker: the text
 *  box (which doubles as the manual PR-number entry) plus the filter bar's author
 *  multi-select, lifecycle-status multi-select, and sort. All of it lives here so
 *  the picker `.tsx` stays a thin shell; the manual PR-number parser is shared
 *  with the escape hatch. */
import { useCallback, useMemo, useState } from 'react';

import type { PrSummary } from '@/lib/bridge';

import type { PrSortOption } from '../PrFilterBar';
import type { ReviewLifecycle, ReviewLifecycleState } from '../prreview-lifecycle';
import type { PrPickerRow } from './PrPicker.types';

/** The list's default order — newest first (the order gh already returns). */
export const DEFAULT_PR_SORT: PrSortOption = 'newest';

/** Total churn (additions + deletions) — the `largest` sort key. */
function churn(pr: PrSummary): number {
  return pr.additions + pr.deletions;
}

/** Order two summaries for the chosen sort. ISO create timestamps sort
 *  lexicographically = chronologically; `largest` is churn-descending. */
function comparePrs(a: PrSummary, b: PrSummary, sort: PrSortOption): number {
  switch (sort) {
    case 'oldest':
      return a.createdAt.localeCompare(b.createdAt);
    case 'largest':
      return churn(b) - churn(a);
    case 'newest':
    default:
      return b.createdAt.localeCompare(a.createdAt);
  }
}

/** Parse a raw PR-number input into a positive integer, or `null` when the input
 *  is empty / non-numeric / not > 0. Digits-only so `1e3`, `-1`, `1.5`, and
 *  whitespace all reject. */
export function parsePrNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export interface UsePrPicker {
  /** The filter box text (also the manual-number entry). */
  query: string;
  setQuery: (value: string) => void;
  /** The open PRs matching every active filter, sorted, each marked selected/not. */
  rows: PrPickerRow[];
  /** A valid positive PR number typed into the filter that is NOT in the open
   *  list — the "review PR #N anyway" escape hatch (closed/old/beyond the cap).
   *  Null when the query is empty, non-numeric, or already an open PR. */
  manualNumber: number | null;
  /** True when the filter box has text (drives the "no matches" copy). */
  hasQuery: boolean;
  /** The distinct author logins in the loaded list (the author filter options). */
  authors: string[];
  /** The selected author logins (empty ⇒ all). */
  selectedAuthors: readonly string[];
  setSelectedAuthors: (authors: readonly string[]) => void;
  /** The selected lifecycle states (empty ⇒ all). */
  selectedStatuses: readonly ReviewLifecycleState[];
  setSelectedStatuses: (statuses: readonly ReviewLifecycleState[]) => void;
  /** The active sort option. */
  sort: PrSortOption;
  setSort: (sort: PrSortOption) => void;
  /** True when the text query, an author/status filter, or a non-default sort is
   *  active — the reset-all affordance shows only then. */
  hasActiveFilters: boolean;
  /** Clear every filter + the text query back to defaults (reset-all). */
  resetAll: () => void;
}

/** Filter the open-PR list by the text box (number/title/branch/author), the
 *  author + lifecycle-status multi-selects, and the sort — then derive the
 *  manual-number escape hatch (the `BranchPicker` "input is also the create
 *  affordance" pattern). Status filtering reads the per-PR lifecycle map the view
 *  model already computes; a PR with no entry reads as `not_reviewed`. */
export function usePrPicker(
  prs: PrSummary[],
  value: number | null,
  statuses: Readonly<Record<number, ReviewLifecycle>>,
): UsePrPicker {
  const [query, setQuery] = useState('');
  const [selectedAuthors, setSelectedAuthors] = useState<readonly string[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<readonly ReviewLifecycleState[]>([]);
  const [sort, setSort] = useState<PrSortOption>(DEFAULT_PR_SORT);

  const authors = useMemo(
    () => Array.from(new Set(prs.map((pr) => pr.author))).sort((a, b) => a.localeCompare(b)),
    [prs],
  );

  const { rows, manualNumber } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const authorSet = new Set(selectedAuthors);
    const statusSet = new Set(selectedStatuses);
    const matched: PrPickerRow[] = prs
      .filter((pr) => {
        if (
          q !== '' &&
          !(
            String(pr.number).includes(q) ||
            pr.title.toLowerCase().includes(q) ||
            pr.headRefName.toLowerCase().includes(q) ||
            pr.author.toLowerCase().includes(q)
          )
        ) {
          return false;
        }
        if (authorSet.size > 0 && !authorSet.has(pr.author)) return false;
        if (statusSet.size > 0) {
          const state = statuses[pr.number]?.state ?? 'not_reviewed';
          if (!statusSet.has(state)) return false;
        }
        return true;
      })
      .sort((a, b) => comparePrs(a, b, sort))
      .map((pr) => ({ pr, selected: pr.number === value }));

    const typed = parsePrNumber(query);
    const manual = typed !== null && !prs.some((pr) => pr.number === typed) ? typed : null;

    return { rows: matched, manualNumber: manual };
  }, [prs, value, query, selectedAuthors, selectedStatuses, sort, statuses]);

  const hasActiveFilters =
    query.trim() !== '' ||
    selectedAuthors.length > 0 ||
    selectedStatuses.length > 0 ||
    sort !== DEFAULT_PR_SORT;

  const resetAll = useCallback(() => {
    setQuery('');
    setSelectedAuthors([]);
    setSelectedStatuses([]);
    setSort(DEFAULT_PR_SORT);
  }, []);

  return {
    query,
    setQuery,
    rows,
    manualNumber,
    hasQuery: query.trim() !== '',
    authors,
    selectedAuthors,
    setSelectedAuthors,
    selectedStatuses,
    setSelectedStatuses,
    sort,
    setSort,
    hasActiveFilters,
    resetAll,
  };
}
