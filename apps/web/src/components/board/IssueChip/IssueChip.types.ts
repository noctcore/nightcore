import type { Task } from '@/lib/bridge';

/** Props for {@link IssueChip} — the `issue #N` provenance chip. */
export interface IssueChipProps {
  /** The task whose linked GitHub issue the chip names. Renders nothing when the task
   *  links no issue (`issueNumber` absent) or when the "closed upstream" chip owns the
   *  slot instead (see `issueClosedUpstream`). */
  task: Task;
}
