/** Local draft state for the plan-approval review panel (T6, #147). Split from the
 *  `.tsx` shell per the folder-per-component convention (no state in the body). */
import { useState } from 'react';

export interface PlanReviewState {
  /** The refine-feedback draft. On Refine it re-enters the SAME session as the
   *  refinement prompt (never a fresh re-run). */
  feedback: string;
  setFeedback: (value: string) => void;
}

/** Owns the plan-review panel's refine-feedback draft. */
export function usePlanReview(): PlanReviewState {
  const [feedback, setFeedback] = useState('');
  return { feedback, setFeedback };
}
