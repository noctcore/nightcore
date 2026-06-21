import type { Task } from '@/lib/bridge';
import { parseVerdict, type Verdict } from '../status';

export interface ReviewPanelView {
  /** The parsed reviewer verdict, or null when none/unparseable. */
  verdict: Verdict | null;
  /** Whether the verdict line was missing/unparseable (shown as a FAIL-safe note). */
  unparseable: boolean;
  /** Whether the bounded auto-fix budget (MAX_FIX_ATTEMPTS = 2) was exhausted. */
  budgetExhausted: boolean;
  /** Whether the Accept / Reject / Rerun actions apply (a parked verification
   *  sitting in `waiting_approval` with a review attached). */
  showActions: boolean;
}

/** The auto-fix budget surfaced in the UI, matching the core's named const. */
export const MAX_FIX_ATTEMPTS = 2;

/** Derive the review panel's view-model from a task's verification fields. */
export function deriveReviewPanelView(task: Task): ReviewPanelView {
  const verdict = parseVerdict(task.review);
  return {
    verdict,
    unparseable: task.review !== null && verdict === null,
    budgetExhausted: task.fixAttempts >= MAX_FIX_ATTEMPTS,
    showActions: task.status === 'waiting_approval' && task.review !== null,
  };
}
