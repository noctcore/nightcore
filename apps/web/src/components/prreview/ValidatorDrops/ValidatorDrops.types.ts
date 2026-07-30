/** Types for the {@link ValidatorDrops} — the collapsed "dropped by the validator"
 *  disclosure that keeps the adversarial validator's deletions VISIBLE. */
import type { ReviewFindingView } from '../prreview.types';

/** Props for the {@link ValidatorDrops}. Self-hides when the list is empty. */
export interface ValidatorDropsProps {
  /** The findings the validator judged unsupported by the diff. Read-only: they
   *  carry no lifecycle, are not selectable, and are never posted. */
  dropped: readonly ReviewFindingView[];
}
