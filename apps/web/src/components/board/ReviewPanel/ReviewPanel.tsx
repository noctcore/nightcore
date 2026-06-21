import { Button, CheckIcon, RetryIcon, VerifiedIcon } from '@/components/ui';
import { VERDICT_LABEL, VERDICT_TEXT } from '../status';
import { deriveReviewPanelView, MAX_FIX_ATTEMPTS } from './ReviewPanel.hooks';
import type { ReviewPanelProps } from './ReviewPanel.types';

/** The verification review panel (M4): renders the reviewer's verdict text with
 *  its parsed verdict, the auto-fix budget note, and — for a parked verification
 *  `waiting_approval` — Accept / Reject / Rerun controls. Pure presentational;
 *  the bridge actions are owned by the detail panel. */
export function ReviewPanel({ task, onAccept, onReject, onRerun }: ReviewPanelProps) {
  if (task.review === null) return null;
  const { verdict, unparseable, budgetExhausted, showActions } = deriveReviewPanelView(task);

  return (
    <section>
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

      <pre className="whitespace-pre-wrap rounded-md border border-border bg-white/[0.02] px-3 py-2 text-sm leading-relaxed text-foreground/90">
        {task.review}
      </pre>

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
    </section>
  );
}
