/** Props for {@link DetailCardGrid}. */
import type { ReactNode } from 'react';

export interface DetailCardGridProps {
  /** True when there are no items AND nothing streaming — shows the empty message. */
  isEmpty: boolean;
  /** Centered message shown when {@link DetailCardGridProps.isEmpty} is true. */
  emptyMessage: string;
  /** Number of skeleton placeholder cards to append while a pass is still streaming. */
  skeletonCount: number;
  /** The rendered cards (typically {@link DetailCard}s mapped from findings). */
  children: ReactNode;
}
