/** The plan-approval review panel (T6, #147): the reviewable plan artifact plus the
 *  approve / refine-with-feedback / reject affordances for a plan-parked
 *  `waiting_approval` task. Mirrors {@link ReviewPanel} (the verification-verdict
 *  sibling): the decision controls live here in the attention band while the footer
 *  only points to them. Refine relays the feedback into the SAME session as the
 *  refinement prompt — the agent revises the plan in place and re-parks it. The
 *  bridge actions come from `TaskActionsContext` (owned by the shell). */
import { Button, CheckIcon, Markdown, RefineIcon, Spinner } from '@/components/ui';

import { useTaskActions } from '../actions';
import { usePlanReview } from './PlanReview.hooks';
import type { PlanReviewProps } from './PlanReview.types';

const FEEDBACK_CLASS =
  'w-full resize-none rounded-[10px] border border-border bg-black/20 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary';

export function PlanReview({ task, pending }: PlanReviewProps) {
  const { onApprove, onRefine, onReject } = useTaskActions();
  const { feedback, setFeedback } = usePlanReview();
  const busy = (action: string): boolean => pending?.(action) ?? false;
  // A plan-parked task always carries its stored plan; guard so the panel never
  // renders an empty box if the plan is somehow absent.
  if (task.plan === null) return null;

  return (
    <section aria-label="Plan approval">
      <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        Proposed plan
      </h3>
      <Markdown className="rounded-md border border-info/40 bg-info/[0.08] px-3 py-2">
        {task.plan}
      </Markdown>

      <label
        htmlFor="plan-refine-feedback"
        className="mb-1.5 mt-3 block font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground"
      >
        Refine feedback
      </label>
      <textarea
        id="plan-refine-feedback"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        rows={2}
        placeholder="What should change? Sent to the same session as the refinement prompt."
        className={FEEDBACK_CLASS}
      />

      <div className="mt-2.5 flex items-center gap-2">
        <Button
          onClick={() => onApprove?.(task.id)}
          disabled={busy('approve')}
          aria-busy={busy('approve')}
        >
          {busy('approve') ? <Spinner /> : <CheckIcon size={14} />}
          {busy('approve') ? 'Approving…' : 'Approve'}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            // Refine carries the feedback into the SAME session, then clears the draft
            // so the field is empty when the revised plan re-parks for another round.
            onRefine?.(task.id, feedback);
            setFeedback('');
          }}
          disabled={busy('refine')}
          aria-busy={busy('refine')}
        >
          {busy('refine') ? <Spinner /> : <RefineIcon size={14} />}
          {busy('refine') ? 'Refining…' : 'Refine'}
        </Button>
        <span className="flex-1" />
        <Button
          variant="danger"
          onClick={() => onReject?.(task.id)}
          disabled={busy('reject')}
          aria-busy={busy('reject')}
        >
          {busy('reject') ? <Spinner /> : null}
          {busy('reject') ? 'Rejecting…' : 'Reject'}
        </Button>
      </div>
    </section>
  );
}
