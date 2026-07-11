import type { Task } from '@/lib/bridge';

/** Props for {@link IssueClosedChip} — the "closed upstream" projection-in chip. */
export interface IssueClosedChipProps {
  /** The task whose linked GitHub issue was observed CLOSED upstream. The chip renders
   *  only when `issueState === 'closed'` and the task itself is not Done/merged (so the
   *  divergence is interesting); otherwise it renders nothing. */
  task: Task;
}
