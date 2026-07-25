/** A compact warning chip on the PR-review RESULTS view naming the lenses whose
 *  pass ERRORED — the DEGRADED-run signal (T10). A review missing a lens's
 *  findings is incomplete and must never read as a clean, full review. Renders
 *  nothing when no lens errored, so the call site is a one-line drop-in. Purely
 *  presentational. */
import { AlertIcon } from '@/components/ui';

import { degradedLensLabels } from './DegradedReviewChip.hooks';
import type { DegradedReviewChipProps } from './DegradedReviewChip.types';

export function DegradedReviewChip({ lenses }: DegradedReviewChipProps) {
  if (lenses.length === 0) return null;
  const labels = degradedLensLabels(lenses);
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-nc border border-warning/40 bg-warning/[0.08] px-4 py-2.5 text-xs-plus text-warning"
    >
      <AlertIcon size={14} className="mt-0.5 shrink-0" />
      <span>
        <span className="font-semibold">Degraded review</span> — {lenses.length}{' '}
        {lenses.length === 1 ? 'lens' : 'lenses'} failed to complete ({labels}).
        This review is incomplete — findings from{' '}
        {lenses.length === 1 ? 'that lens' : 'those lenses'} are missing.
      </span>
    </div>
  );
}
