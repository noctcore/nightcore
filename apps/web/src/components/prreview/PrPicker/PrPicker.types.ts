/** Types for the PR Review pull-request picker. */
import type { PrSummary } from '@/lib/bridge';

import type { ReviewLifecycle } from '../prreview-lifecycle';

/** Props for the presentational {@link PrPicker}. The parent (PrReviewView) owns
 *  the open-PR fetch (via `useOpenPrs`), the chosen value, and the per-PR run
 *  registry projections, so the picker itself is a controlled, list-in /
 *  selection-out view — testable with plain props, exactly like `BranchPicker`. */
export interface PrPickerProps {
  /** The active project's open pull requests, newest first. */
  prs: PrSummary[];
  /** True while the list is being (re)fetched. */
  loading: boolean;
  /** A fetch error to surface inline (gh not installed / no remote / auth), or null. */
  error: string | null;
  /** The currently chosen PR number, or null when none is selected. */
  value: number | null;
  /** Choose a PR (from the list or a typed number), or clear with null. */
  onChange: (prNumber: number | null) => void;
  /** Re-fetch the open-PR list. */
  onRefresh: () => void;
  /** Disable all interaction (e.g. while a run is starting). */
  disabled?: boolean;
  /** Per-PR review lifecycle (`deriveReviewLifecycle`) — each listed row shows a
   *  status dot + short label. A missing entry renders a bare row (no dot). Also
   *  the source of the lifecycle-status filter. */
  statuses?: Readonly<Record<number, ReviewLifecycle>>;
  /** Open-finding count of each PR's latest COMPLETED run (`findingCountForPr`).
   *  Missing/zero entries render no count badge. */
  findingCounts?: Readonly<Record<number, number>>;
  /** Whether more PRs may exist beyond the current fetch cap (drives the footer's
   *  "Load more" vs. "All loaded"). Absent ⇒ no load-more footer. */
  hasMore?: boolean;
  /** Fetch the next page (refetch at a doubled cap). Absent ⇒ no load-more. */
  onLoadMore?: () => void;
  /** True while the doubled-cap refetch is in flight (the existing rows stay). */
  loadingMore?: boolean;
}

/** One rendered PR row (a summary plus whether it is the chosen one). */
export interface PrPickerRow {
  pr: PrSummary;
  selected: boolean;
}
