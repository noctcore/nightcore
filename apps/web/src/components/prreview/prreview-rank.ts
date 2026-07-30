/**
 * Display RANKING for PR-review findings (review-calibration slice 2).
 *
 * The shared `sortBySeverityThenStatus` orders every grounded-finding grid by
 * open-first → severity; PR Review adds ONE more signal the sibling scans don't have:
 * CORROBORATION. A finding two lenses independently surfaced is far likelier to be real
 * than a solo low, so it sorts above its severity peers and carries the "N lenses agree"
 * chip.
 *
 * KEEPS EVERY FINDING — this is a comparator, never a filter: no per-lens budget, no
 * cap, no suppression, no demotion out of the list (locked decision — transparency over
 * brevity). It also never reads or writes a severity beyond comparing it, so it can't
 * influence the mechanical verdict clamp.
 *
 * Mirrors the engine's `rankPrReviewFindings` (packages/engine/src/scans/pr-review/
 * corroborate.ts) so the grid order matches the order the completed event arrived in —
 * with the extra open-before-resolved key the UI needs and the engine has no concept of.
 */
import { severityRankValue } from '@/lib/severity';

import { ALL_LENSES } from './prreview.constants';
import type { ReviewFindingView } from './prreview.types';

/** How many lenses back a finding: its own reporting lens plus its corroborators.
 *  A solo finding scores 1. */
export function corroborationCount(finding: ReviewFindingView): number {
  return 1 + finding.corroboratedBy.length;
}

/** Lens tiebreak position — the contract's display order; an unknown lens sorts last
 *  rather than throwing (a corrupt persisted value must not break the grid). */
function lensRank(lens: ReviewFindingView['lens']): number {
  const index = ALL_LENSES.indexOf(lens);
  return index === -1 ? ALL_LENSES.length : index;
}

/**
 * Order findings for the results grid: OPEN before resolved (dismissed / converted) →
 * severity desc → corroboration count desc → lens order → stable input order. Returns a
 * new array of the SAME length; the input is untouched.
 */
export function rankReviewFindings(
  findings: readonly ReviewFindingView[],
): ReviewFindingView[] {
  const statusRank = (f: ReviewFindingView): number => (f.status === 'open' ? 0 : 1);
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      const status = statusRank(a.finding) - statusRank(b.finding);
      if (status !== 0) return status;
      const severity =
        severityRankValue(b.finding.severity) - severityRankValue(a.finding.severity);
      if (severity !== 0) return severity;
      const corroboration =
        corroborationCount(b.finding) - corroborationCount(a.finding);
      if (corroboration !== 0) return corroboration;
      const lens = lensRank(a.finding.lens) - lensRank(b.finding.lens);
      if (lens !== 0) return lens;
      return a.index - b.index;
    })
    .map((entry) => entry.finding);
}
