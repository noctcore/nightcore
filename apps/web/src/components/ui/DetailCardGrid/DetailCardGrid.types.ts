/** Props for {@link DetailCardGrid}. */
import type { ReactNode } from 'react';

export interface DetailCardGridProps {
  /** True when there are no items AND nothing streaming — shows the empty message. */
  isEmpty: boolean;
  /** Centered message shown when {@link DetailCardGridProps.isEmpty} is true. */
  emptyMessage: string;
  /** Number of skeleton placeholder cards to append while a pass is still streaming. */
  skeletonCount: number;
  /** The rendered cards (typically {@link DetailCard}s mapped from findings).
   *  Wrap a non-card item (a section header or summary banner) in
   *  {@link GridFullRow} to give it its own full-width row instead of packing
   *  it beside cards. */
  children: ReactNode;
  /** True when this grid is embedded in an ALREADY-scrolling ancestor page
   *  (e.g. the PR Review panel, which scrolls as one continuous surface)
   *  rather than owning a bounded flex box of its own. Skips the grid's own
   *  `overflow-y-auto` and virtualizes against the nearest scrollable
   *  ancestor instead, so the page never double-scrolls. Defaults to false —
   *  the grid owns its own bounded scroll box, as Insight/Harness do. */
  scrollsWithPage?: boolean;
}
