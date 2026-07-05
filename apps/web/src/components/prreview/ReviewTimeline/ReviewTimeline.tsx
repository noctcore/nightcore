/** The vertical review-arc stepper for the selected PR: reviewed → posted → fix
 *  running → pushed → re-review, with timestamps from the run/fix records. It
 *  unifies what the History menu (past runs) and the FixRunCard (fix lifecycle)
 *  surface separately into one at-a-glance timeline — both of those keep working;
 *  this complements them. Purely presentational; the steps are derived in the
 *  view model ({@link deriveReviewTimeline}). Self-hides when there's no genuine
 *  arc (a lone live/failed node is already covered elsewhere). */
import { AlertIcon, CheckIcon } from '@/components/ui';

import type { TimelineStepState } from '../prreview-lifecycle';
import { formatTimelineTime, hasTimelineArc } from './ReviewTimeline.hooks';
import type { ReviewTimelineProps } from './ReviewTimeline.types';

/** Node dot chrome per step state (border/text tone + pulse for the live node). */
function nodeClass(state: TimelineStepState): string {
  switch (state) {
    case 'done':
      return 'border-success/60 bg-background text-success';
    case 'current':
      return 'border-primary bg-background text-primary';
    case 'alert':
      return 'border-destructive/60 bg-background text-destructive';
    default:
      return 'border-border bg-background text-muted-foreground';
  }
}

/** Label tone per step state. */
function labelClass(state: TimelineStepState): string {
  switch (state) {
    case 'current':
      return 'text-primary';
    case 'alert':
      return 'text-destructive';
    case 'upcoming':
      return 'text-muted-foreground';
    default:
      return 'text-foreground';
  }
}

export function ReviewTimeline({ steps }: ReviewTimelineProps) {
  if (!hasTimelineArc(steps)) return null;

  return (
    <div className="flex flex-col gap-2 rounded-[12px] border border-border bg-white/[0.02] p-4">
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        Review timeline
      </span>
      <ol className="relative ml-1 flex flex-col gap-3 border-l border-border pl-4 pt-1">
        {steps.map((step) => {
          const when = formatTimelineTime(step.at);
          return (
            <li
              key={step.id}
              aria-current={step.state === 'current' ? 'step' : undefined}
              className="relative flex flex-col gap-0.5"
            >
              {/* Node dot straddling the rail. A pulse marks the live node
                  (neutralized under prefers-reduced-motion by the global rule). */}
              <span
                aria-hidden
                style={
                  step.state === 'current'
                    ? { animation: 'nc-pulse 1.6s ease-in-out infinite' }
                    : undefined
                }
                className={`absolute -left-[23px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full border p-0.5 ${nodeClass(
                  step.state,
                )}`}
              >
                {step.state === 'done' ? (
                  <CheckIcon size={9} />
                ) : step.state === 'alert' ? (
                  <AlertIcon size={9} />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                )}
              </span>
              <span className={`text-[12.5px] font-medium ${labelClass(step.state)}`}>
                {step.label}
              </span>
              {when !== null && (
                <span className="font-mono text-[10.5px] text-muted-foreground/70">{when}</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
