/** Types for the {@link PostReviewDialog} — the human gate that posts a review to
 *  GitHub. It renders the PRE-FILLED verdict + the inline/body split and requires an
 *  explicit confirmation; no code path here posts on its own. */
import type { PostReviewGate } from '../prreview.types';

/** Props for the {@link PostReviewDialog}. The whole gate rides as ONE bundle: the
 *  dialog is its single consumer, and exploding it into a dozen props would say
 *  less about what it is. */
export interface PostReviewDialogProps {
  post: PostReviewGate;
}
