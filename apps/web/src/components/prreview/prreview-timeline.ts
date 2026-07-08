/**
 * Review-arc timeline derivation: unifies the latest persisted run + fix state
 * into the stepper consumed by ReviewTimeline + History + FixRunCard surfaces.
 * Pure (no React). Extracted from prreview-lifecycle.ts to shrink the god module.
 */

import type { PrFixState, PrReviewRun } from '@/lib/bridge';

/** Count OPEN findings across either finding source (both carry `status`). */
function countOpen(findings: ReadonlyArray<{ status: string }>): number {
  return findings.filter((f) => f.status === 'open').length;
}

/** A review-arc timeline node's completion state — mapped to a dot glyph + tone
 *  by the {@link ../ReviewTimeline}. */
export type TimelineStepState = 'done' | 'current' | 'upcoming' | 'alert';

/** One node on the PR's review arc (reviewed → posted → fix → pushed →
 *  re-review). `at` is an epoch-ms timestamp, or null when the step hasn't
 *  happened / carries no time. */
export interface TimelineStep {
  id: string;
  label: string;
  state: TimelineStepState;
  at: number | null;
}

/**
 * Derive the PR's review-arc timeline from its latest persisted run + fix (the
 * same inputs the History menu and FixRunCard read separately), unifying them
 * into one stepper. A live/failed review short-circuits to a single node (the
 * results banner + status line own that detail); a completed review yields the
 * reviewed → posted arc, extended by a fix node and a re-review nudge when the
 * branch has moved. Pure — the component renders whatever comes back.
 */
export function deriveReviewTimeline(
  latestRun: PrReviewRun | null,
  fix: PrFixState | null,
  stale = false,
): TimelineStep[] {
  if (latestRun === null) return [];

  if (latestRun.status === 'running') {
    return [{ id: 'review', label: 'Reviewing', state: 'current', at: latestRun.createdAt }];
  }
  if (latestRun.status === 'failed') {
    return [{ id: 'review', label: 'Review failed', state: 'alert', at: latestRun.updatedAt }];
  }

  const steps: TimelineStep[] = [
    { id: 'review', label: 'Reviewed', state: 'done', at: latestRun.createdAt },
  ];

  // Posted — a real GitHub post (done, with its time) or the pending/none rest.
  const posted = latestRun.postedVerdict !== null && latestRun.postedVerdict !== '';
  if (posted) {
    steps.push({ id: 'posted', label: 'Posted to GitHub', state: 'done', at: latestRun.postedAt });
  } else {
    const openCount = countOpen(latestRun.findings);
    steps.push({
      id: 'posted',
      label: openCount > 0 ? 'Pending post' : 'Nothing to post',
      state: 'upcoming',
      at: null,
    });
  }

  // Fix arc (only when a fix exists for the PR).
  if (fix !== null) {
    if (fix.status === 'running' || fix.status === 'committing') {
      steps.push({ id: 'fix', label: 'Fix running', state: 'current', at: fix.updatedAt });
    } else if (fix.status === 'awaiting_push') {
      steps.push({ id: 'fix', label: 'Fix ready to push', state: 'current', at: fix.updatedAt });
    } else if (fix.status === 'pushed') {
      steps.push({ id: 'fix', label: 'Fix pushed', state: 'done', at: fix.updatedAt });
    } else if (fix.status === 'failed') {
      steps.push({ id: 'fix', label: 'Fix failed', state: 'alert', at: fix.updatedAt });
    }
  }

  // Re-review nudge when the branch advanced past the reviewed head.
  if (stale) {
    steps.push({ id: 're-review', label: 'Re-review — branch moved', state: 'upcoming', at: null });
  }

  return steps;
}
