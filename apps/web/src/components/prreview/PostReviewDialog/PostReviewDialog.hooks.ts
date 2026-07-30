/** Pure copy/derivation helpers for the {@link PostReviewDialog}. The dialog holds NO
 *  state of its own — the gate (armed verdict, in-flight flag, split toggle) lives in
 *  the PrReviewView model, so this file is derivation only. */
import { VERDICT_META } from '../prreview.constants';
import type { PostReviewGate, ReviewVerdict } from '../prreview.types';

/** The three verdicts in display order — the selector's option order. */
export const POST_VERDICTS: ReviewVerdict[] = ['approve', 'request-changes', 'comment'];

/** What the dialog needs to render, derived from the gate. */
export interface PostGateView {
  /** Display meta for the ARMED verdict, or `null` when the gate is closed. */
  meta: (typeof VERDICT_META)[ReviewVerdict] | null;
  /** True when the armed verdict is the one the gate pre-filled (so the copy can
   *  say "pre-filled" instead of naming a different recommendation). */
  isRecommended: boolean;
  /** The clamp explanation, when the run carried one (empty string ⇒ none). */
  clampNote: string;
}

/** Derive the dialog's view from the gate. Pure + total. */
export function describePostGate(post: PostReviewGate): PostGateView {
  return {
    meta: post.postVerdict === null ? null : VERDICT_META[post.postVerdict],
    isRecommended: post.postVerdict === post.recommendedVerdict,
    clampNote: post.clampReason ?? '',
  };
}
