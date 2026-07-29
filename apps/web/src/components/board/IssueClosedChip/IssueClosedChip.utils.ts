/** Pure predicates shared by the two issue chips, so exactly ONE place decides which of
 *  them a card shows. Duplicating this condition would let the plain `Issue #N` chip and
 *  the "closed upstream" chip drift into rendering together (or neither). */
import type { Task } from '@/lib/bridge';

/** Whether the task's linked GitHub issue was last observed CLOSED upstream while the
 *  task itself is still open (#97 PR 4, §5).
 *
 *  This is the DIVERGENCE condition — the only case worth surfacing. It is hidden once
 *  the task reaches Done/merged, because then the issue closing is the expected outcome,
 *  not a divergence. `issueState` is a last-observed projection (`null` until the first
 *  poll), never a gate on anything. Pure. */
export function issueClosedUpstream(task: Task): boolean {
  return (
    (task.issueNumber ?? null) !== null &&
    task.issueState === 'closed' &&
    task.status !== 'done' &&
    !task.merged
  );
}
