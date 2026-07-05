/** Pure presentation helpers for the {@link ReviewTimeline}. No state — the
 *  stepper is a controlled projection of derived steps — so this file exports
 *  only formatters (the component-folder convention still expects it present). */
import type { TimelineStep } from '../prreview-lifecycle';

/** Whether there is a genuine arc worth rendering — a lone node (a live/failed
 *  review) is already covered by the status line + results banner. */
export function hasTimelineArc(steps: TimelineStep[]): boolean {
  return steps.length >= 2;
}

/** Format a step's epoch-ms timestamp as a short local date-time, or null when
 *  the step carries no time (so the caller omits the line). */
export function formatTimelineTime(at: number | null): string | null {
  if (at === null || !Number.isFinite(at)) return null;
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
