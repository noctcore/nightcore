/**
 * TRUSTED-POSTING PRE-FILL (review-calibration slice 3).
 *
 * Real-run evidence: 11–28 findings per review and ZERO ever posted. The post gate
 * asked the human to rebuild the whole review from scratch — pick a verdict with no
 * anchor, then decide finding-by-finding what deserves an inline comment. This module
 * is the pure math behind the pre-fill that removes that friction:
 *
 *  - {@link recommendedReviewVerdict} maps the run's CLAMPED merge verdict onto the
 *    GitHub review verdict the toolbar highlights and the dialog opens with;
 *  - {@link splitForPosting} pre-selects which selected findings ride as INLINE
 *    comments and which stay in the review BODY note.
 *
 * The human ALWAYS confirms. Nothing here posts, and nothing here is binding: the
 * recommendation is a highlight the human can override with any verdict, and the split
 * is re-derivable with `allInline`. The one hard gate — an explicit confirmation in the
 * post dialog — is untouched by this module (see `prreview-gates.hooks.ts`).
 *
 * No React, no bridge calls: pure functions over the view model.
 */
import type { ReviewSeverity } from '@/lib/bridge';

import type { ReviewFindingView, ReviewVerdict } from './prreview.types';

/**
 * Clamped `MergeVerdict` (the engine's mechanically-banded read on the PR) → the
 * GitHub review verdict to pre-fill. `merge_with_changes` deliberately maps to
 * `comment` rather than `request-changes`: the clamp only reaches that band on
 * medium-and-below findings, and a low-severity nit-list must never pre-arm a
 * blocking review (locked decision — lows-only can never reach `needs_revision`).
 */
export const VERDICT_PREFILL: Record<string, ReviewVerdict> = {
  ready: 'approve',
  merge_with_changes: 'comment',
  needs_revision: 'request-changes',
  blocked: 'request-changes',
};

/**
 * The verdict the post gate pre-fills, from the displayed run's CLAMPED merge verdict.
 *
 * Falls back to `comment` — the always-allowed, non-committal verdict — for an unknown
 * or absent verdict (a fail-open run whose synthesis pass errored, or a run from an
 * older engine) AND on the viewer's OWN pull request, where GitHub refuses
 * approve/request-changes outright. A recommendation the API would reject is not a
 * recommendation.
 */
export function recommendedReviewVerdict(
  mergeVerdict: string | null,
  ownPr: boolean,
): ReviewVerdict {
  const mapped = mergeVerdict === null ? undefined : VERDICT_PREFILL[mergeVerdict];
  if (mapped === undefined) return 'comment';
  return ownPr && mapped !== 'comment' ? 'comment' : mapped;
}

/**
 * The severities that earn an INLINE comment on their own. Lows/info stay in the body
 * note by default — they are the bulk of the noise, and a review that pins 20 inline
 * nits to a contributor's diff is exactly the reviewer nobody trusts. Named + exported
 * so the tier is retunable in one place against real-run data (T9, #150).
 */
export const INLINE_SEVERITIES: readonly ReviewSeverity[] = [
  'critical',
  'high',
  'medium',
];

/** The pre-selected posting split. Both halves are POSTED — nothing is dropped; the
 *  split only decides WHERE each finding appears in the review. */
export interface PostingSplit {
  /** Findings pre-selected as inline diff comments. */
  inline: ReviewFindingView[];
  /** Findings that ride in the review BODY note instead (lows/info, and anything
   *  with no line to anchor to). */
  body: ReviewFindingView[];
}

/**
 * Split the selected findings into the pre-selected inline / body halves.
 *
 * A finding rides INLINE when it carries a line anchor AND is either high-signal by
 * severity ({@link INLINE_SEVERITIES}) or CORROBORATED (two lenses independently
 * surfacing an issue is the strongest evidence it is real — the same signal that ranks
 * it to the top). Everything else — lows, info, and anything with no line — rides in
 * the body note. `allInline` is the human's edit: it promotes every anchorable
 * selection to an inline comment.
 *
 * The line check is a NECESSARY condition, not the authoritative one: GitHub validates
 * inline anchors against the PR's CURRENT diff all-or-nothing, so the Rust post seam
 * (`workflow::pr_review_post::anchor`, T10/#196) re-anchors every comment at post time
 * and DEMOTES the un-anchorable ones into the body. This pre-fill just avoids proposing
 * comments that obviously can't anchor.
 */
export function splitForPosting(
  findings: readonly ReviewFindingView[],
  allInline = false,
): PostingSplit {
  const inline: ReviewFindingView[] = [];
  const body: ReviewFindingView[] = [];
  for (const finding of findings) {
    const anchorable = finding.line !== null;
    const highSignal =
      allInline ||
      INLINE_SEVERITIES.includes(finding.severity) ||
      finding.corroboratedBy.length > 0;
    if (anchorable && highSignal) inline.push(finding);
    else body.push(finding);
  }
  return { inline, body };
}
