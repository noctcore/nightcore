/** Types for the PR list's filter bar — the author multi-select, the
 *  lifecycle-status multi-select, the sort control, and reset-all. The picker
 *  owns the filter state (see {@link ../PrPicker/PrPicker.hooks}); the bar is a
 *  controlled, presentational composition. */
import type { ReviewLifecycleState } from '../prreview-lifecycle';

/** How the list is ordered. `newest`/`oldest` sort by the PR's create timestamp;
 *  `largest` by total churn (additions + deletions). `newest` is the default (the
 *  order gh already returns). Defined here so `PrPicker.hooks` can import it
 *  without a folder cycle (the bar never imports the picker). */
export type PrSortOption = 'newest' | 'oldest' | 'largest';

/** Props for the presentational {@link PrFilterBar}. Every list/selection value
 *  is supplied by the picker; every change is reported up. */
export interface PrFilterBarProps {
  /** The distinct author logins available to filter by (from the loaded list). */
  authors: readonly string[];
  /** The currently-selected author logins (empty ⇒ all authors). */
  selectedAuthors: readonly string[];
  /** Replace the selected author set. */
  onAuthorsChange: (authors: readonly string[]) => void;
  /** The currently-selected lifecycle states (empty ⇒ all states). */
  selectedStatuses: readonly ReviewLifecycleState[];
  /** Replace the selected lifecycle-state set. */
  onStatusesChange: (statuses: readonly ReviewLifecycleState[]) => void;
  /** The active sort option. */
  sort: PrSortOption;
  /** Choose a sort option. */
  onSortChange: (sort: PrSortOption) => void;
  /** Whether any filter (text/author/status) or non-default sort is active — the
   *  reset-all affordance shows only then. */
  hasActiveFilters: boolean;
  /** Clear every filter and the text query back to defaults (reset-all). */
  onReset: () => void;
  /** Disable all controls (e.g. while the list is (re)loading). */
  disabled?: boolean;
}
