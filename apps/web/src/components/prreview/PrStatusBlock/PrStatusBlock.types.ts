/** Types for the PR Review workspace status block. */
import type { PrStatus } from '@/lib/bridge';

import type { PrNumberStatusView } from './PrStatusBlock.hooks';

/** Props for the {@link PrStatusBlock}. In the app the PrReviewView model LIFTS
 *  `usePrStatusByNumber` (so the workspace status line + review-position banners
 *  read the same fetched status) and passes it as `view`; the self-fetch stays
 *  as the fallback for stories/tests. Fetch on selection + manual refresh only,
 *  NO polling. */
export interface PrStatusBlockProps {
  /** The selected PR's number (the self-fetch re-keys when it changes). */
  prNumber: number;
  /** A lifted status view from the owner — when provided, the block renders it
   *  and does NOT self-fetch (the sanctioned lift, mirroring `PrStatusCard`). */
  view?: PrNumberStatusView;
  /** Story/test seam: when provided (including `null` = unavailable), no fetch
   *  ever fires and the block renders this snapshot directly. */
  override?: PrStatus | null;
}
