/** Reviewer-verdict and structure-lock panel for a verified/parked task. */
import { Button, CheckIcon, Markdown, RetryIcon, VerifiedIcon } from '@/components/ui';
import { VERDICT_LABEL, VERDICT_TEXT } from '../status';
import { deriveReviewPanelView, MAX_FIX_ATTEMPTS } from './ReviewPanel.hooks';
import type { ReviewPanelProps } from './ReviewPanel.types';

/** The verification review panel: renders the reviewer's verdict text with
 *  its parsed verdict, the auto-fix budget note, and — for a parked verification
 *  `waiting_approval` — Accept / Reject / Rerun controls. Pure presentational;
 *  the bridge actions are owned by the detail panel. */
export function ReviewPanel({ task, onAccept, onReject, onRerun }: ReviewPanelProps) {
  const lock = task.structureLockResult;
  const lockFailed = lock !== null && !lock.passed;
  // Render even with no reviewer verdict when the Structure-Lock Gauntlet failed —
  // that failure parks the task before any reviewer runs, so the alert is the only
  // thing the user sees explaining why it stalled.
  if (task.review === null && !lockFailed) return null;
  const { verdict, unparseable, budgetExhausted, showActions } = deriveReviewPanelView(task);

  return (
    <section>
      {lockFailed && (
        <div
          role="alert"
          className="mb-2.5 rounded-md border border-destructive/50 bg-destructive/[0.08] px-3 py-2"
        >
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-destructive">
            Structure lock failed
          </p>
          <p className="mt-1 text-xs text-foreground/90">
            The project's harness check{' '}
            <span className="font-mono font-semibold text-destructive">
              {lock?.failedCheck ?? 'unknown'}
            </span>{' '}
            did not pass. This work cannot be verified or merged until it is fixed.
          </p>
        </div>
      )}

      {task.review !== null && (
        <>
          <div className="mb-1.5 flex items-center gap-2">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          Reviewer verdict
        </h3>
        {verdict !== null && (
          <span
            className={`flex items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] ${VERDICT_TEXT[verdict]}`}
          >
            <VerifiedIcon size={12} />
            {VERDICT_LABEL[verdict]}
          </span>
        )}
        {unparseable && (
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-destructive">
            No verdict — treated as fail
          </span>
        )}
      </div>

      <Markdown className="rounded-md border border-border bg-white/[0.02] px-3 py-2">
        {task.review}
      </Markdown>

      {budgetExhausted && (
        <p className="mt-1.5 font-mono text-[11px] text-warning">
          Auto-fix budget exhausted ({MAX_FIX_ATTEMPTS} attempts).
        </p>
      )}

      {showActions && (
        <div className="mt-2.5 flex items-center gap-2">
          <Button onClick={() => onAccept?.(task.id)}>
            <CheckIcon size={14} />
            Accept
          </Button>
          {onRerun !== undefined && (
            <Button variant="secondary" onClick={() => onRerun(task.id)}>
              <RetryIcon size={14} />
              Rerun
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="danger" onClick={() => onReject?.(task.id)}>
            Reject
          </Button>
        </div>
      )}
        </>
      )}
    </section>
  );
}
