/** Types for the RunDeltaBar: the run-over-run delta result plus the presentational
 *  props the RESULTS screen passes in. */
import type { InsightDeltaResult } from '../insight-delta';

/** Props for the RunDeltaBar — the apparent run-over-run delta strip (issue #403). */
export interface RunDeltaBarProps {
  /** The apparent fingerprint set-diff against the previous comparable run, or the
   *  reason no comparison is possible (see `insight-delta.ts`). */
  result: InsightDeltaResult;
  /** Relative age of the compared-against run (`"2h ago"`), formatted upstream so
   *  this component renders deterministically. `null` when there is no comparison. */
  previousRunLabel: string | null;
  /** Extra classes for call-site spacing (e.g. `mx-6 mt-4`). */
  className?: string;
}
