/** Public props for the shared BulkConvertBar. */
import type { ReactNode } from 'react';

/** The progress counters the bar renders while the convert-all loop runs. A
 *  structural subset of `useBulkConvert`'s `BulkConvertProgress` (which also
 *  carries `failed`) so a caller can pass that value straight through. */
export interface BulkConvertProgressLike {
  done: number;
  total: number;
}

/** The bar's render contract — the display slice of a `useBulkConvert` machine
 *  plus the open-item `count`. A scan view exposes exactly this shape (flat, as
 *  Insight/Scorecard do, or as a cohesive sub-object where the view model's
 *  return surface is budgeted, as Harness does) and spreads it into the bar. */
export interface BulkConvertBarProps {
  /** Count of open / convertible items — the button's `(N)` and the inert gate. */
  count: number;
  /** True while the sequential convert-all loop runs. */
  converting: boolean;
  /** Progress counters for the in-flight loop. */
  progress: BulkConvertProgressLike;
  /** Polite aria-live announcement ('' when idle, terminal summary once settled). */
  statusMessage: string;
  /** Inline (visible) failure summary when conversions rejected mid-loop, else `null`. */
  error: string | null;
  /** Start the convert-all loop over the open items (a no-op when inert). */
  onConvertAll: () => void;
  /** Optional sibling action rendered at the trailing (right) edge of the SAME
   *  bar — used by the scan-results views to place "Export to GitHub" next to
   *  convert-all rather than in a second stacked bar. Omit for the bare bar. */
  trailing?: ReactNode;
}
