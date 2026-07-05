/** Types for the PR Review workspace status block. */
import type { PrStatus } from '@/lib/bridge';

import type { PrNumberStatusView } from './PrStatusBlock.hooks';

/** The status block's REMEDIATION actions: the human gates for launching a fix
 *  agent against what the status line reports (failing checks → "Fix CI";
 *  conflicts → "Resolve conflicts"). Both ARM a ConfirmDialog in the owner —
 *  neither starts a paid session directly. */
export interface PrStatusActions {
  /** Arm the fix-failing-CI gate. */
  onFixCi: () => void;
  /** Arm the resolve-conflicts gate. */
  onResolveConflicts: () => void;
  /** True while ANY fix for this PR is live (running/committing) or starting —
   *  both buttons render inert (focusable, aria-disabled) with the reason. */
  fixBusy: boolean;
}

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
  /** The remediation actions (Fix CI / Resolve conflicts). Omitted in contexts
   *  without the fix arc (stories/tests) — the buttons then don't render. */
  actions?: PrStatusActions;
}
