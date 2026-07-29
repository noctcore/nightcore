/** Presentational band groups lifted out of `TaskDetail.tsx` (the sanctioned `.parts.tsx`
 *  overflow pattern) so the drawer's entry file stays under the size caps. These own no
 *  state and no fetches — the views are LIFTED in the drawer and passed in. */
import { PrReviewComments } from '../PrReviewComments';
import { PrStatusCard } from '../PrStatusCard';
import { GroupLabel } from '../SessionCard';
import type { TaskDetailPrBandsProps } from './TaskDetail.types';

/** The two PR bands, both gated on the same condition (`task.prUrl` exists):
 *
 *  - **Pull request** — live GitHub status for the task's PR (phase 2): state / review /
 *    checks badges plus the human-gated push-updates, remote-merged finalize, and base
 *    fast-forward actions. Fetches on mount + manual refresh only; sits directly below the
 *    Result band's gauntlet.
 *  - **Review comments** — the UNRESOLVED inline threads + top-level review summaries
 *    (phase 3), read-only, plus the single human-gated Address-comments action (dispatches
 *    a fix run over the worktree). Comment bodies are untrusted external text.
 *
 *  Both cards are keyed per task (suspenders — each hook's own task-switch reset is the
 *  belt), so a switch remounts them: no stale status/payload/error snapshot and no armed
 *  confirm dialog can carry from task A to B. */
export function TaskDetailPrBands({
  task,
  prStatusView,
  prReviewCommentsView,
  isActionPending,
}: TaskDetailPrBandsProps) {
  if (task.prUrl === undefined) return null;
  return (
    <>
      <div className="space-y-3">
        <GroupLabel>Pull request</GroupLabel>
        <PrStatusCard
          key={task.id}
          task={task}
          view={prStatusView}
          isActionPending={isActionPending}
        />
      </div>

      <div className="space-y-3">
        <GroupLabel>Review comments</GroupLabel>
        <PrReviewComments
          key={task.id}
          task={task}
          view={prReviewCommentsView}
          isActionPending={isActionPending}
        />
      </div>
    </>
  );
}
