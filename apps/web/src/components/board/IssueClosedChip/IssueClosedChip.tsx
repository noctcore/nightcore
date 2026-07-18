import { GithubIcon } from '@/components/ui';

import { useIssueClosedChip } from './IssueClosedChip.hooks';
import type { IssueClosedChipProps } from './IssueClosedChip.types';

/** GitHub two-way sync (#97 PR 4, §5) — the "closed upstream" chip. Surfaces on a task
 *  card/detail when its linked GitHub issue was observed CLOSED upstream while the task is
 *  still open (not Done/merged). INFORMATIONAL only: clicking opens the issue on GitHub so
 *  the user decides what to do — Nightcore never auto-cancels the run, moves the card, or
 *  closes the task. `stopPropagation` keeps a click on a card from also selecting/dragging
 *  it. Renders nothing when the linked issue is open (or the task links none). */
export function IssueClosedChip({ task }: IssueClosedChipProps) {
  const { visible, issueNumber, open } = useIssueClosedChip(task);
  if (!visible || issueNumber === null) return null;
  return (
    <button
      type="button"
      title="This issue was closed on GitHub — open it to decide what to do"
      aria-label={`Issue #${issueNumber} closed upstream — open it on GitHub`}
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
      className="flex items-center gap-1 rounded-md bg-warning/[0.12] px-1.5 py-0.5 font-mono text-4xs-plus text-warning transition-colors hover:bg-warning/20"
    >
      <GithubIcon size={11} />
      issue #{issueNumber} closed upstream
    </button>
  );
}
