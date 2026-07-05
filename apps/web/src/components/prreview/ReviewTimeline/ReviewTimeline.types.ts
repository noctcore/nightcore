/** Types for the {@link ReviewTimeline} — the vertical review-arc stepper that
 *  unifies what the History menu + FixRunCard show separately (reviewed → posted
 *  → fix → pushed → re-review) into one timeline for the selected PR. */
import type { TimelineStep } from '../prreview-lifecycle';

export interface ReviewTimelineProps {
  /** The PR's review-arc nodes (from {@link deriveReviewTimeline}). The component
   *  self-hides when there is no genuine arc to show (fewer than two nodes). */
  steps: TimelineStep[];
}
