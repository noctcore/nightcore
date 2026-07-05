/** Types for the {@link ReviewPosition} — the results-header review-position
 *  layer: the displayed run's merge verdict, the posted-verdict reconciliation
 *  banner, the staleness chip, and the follow-up comparison summary. */
import type { FollowupComparison } from '../prreview-lifecycle';

/** The review-position bundle the results slice carries (all derived in the
 *  PrReviewView model). Every piece is independently optional-by-emptiness — the
 *  component renders nothing when none applies. */
export interface ReviewPositionData {
  /** The displayed run's synthesis merge verdict (wire `MergeVerdict` string),
   *  or `null` — an absent/unknown verdict renders no badge. */
  verdict: string | null;
  /** The verdict's short justification, revealed in a collapsible; `null` when
   *  the run carries no reasoning. */
  verdictReasoning: string | null;
  /** Live-status contradictions against a POSTED approving verdict (the
   *  reconciliation banner names each). Empty → no banner. */
  reconciliation: readonly string[];
  /** True when the branch advanced past the reviewed head (the staleness chip +
   *  a re-review nudge). */
  stale: boolean;
  /** Latest-vs-previous run comparison for the header summary, or `null` when
   *  the PR has fewer than two persisted runs. */
  followup: FollowupComparison | null;
  /** Start a fresh review of this PR — the re-review nudge action shared by the
   *  reconciliation banner and the staleness chip. */
  onReReview: () => void;
}

/** Props for the presentational {@link ReviewPosition}. */
export type ReviewPositionProps = ReviewPositionData;
