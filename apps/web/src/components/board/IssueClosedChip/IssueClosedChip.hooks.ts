import { useCallback } from 'react';

import { openIssueInBrowser, type Task } from '@/lib/bridge';

/** The chip's view: whether it renders, the issue number it names, and the open action. */
export interface IssueClosedChipView {
  /** Render only when the linked issue is CLOSED upstream and the task itself is not
   *  Done/merged — i.e. the divergence is worth surfacing to the user. */
  visible: boolean;
  /** The linked issue number, or `null` when the task links no issue. */
  issueNumber: number | null;
  /** Open the issue on GitHub in the system browser (READ-ONLY — no task mutation). */
  open: () => void;
}

/** Drive the "closed upstream" chip (#97 PR 4, §5). PURE projection: the chip is a
 *  last-observed-state read (`task.issueState`), never a mutation — clicking only opens
 *  the issue on GitHub so the user can decide (keep working, or move the card themselves).
 *  It is hidden once the task reaches Done/merged, since then the issue closing is the
 *  expected outcome, not a divergence. State-free (the open handler lives here, not the
 *  component body, per the no-state-in-body convention). */
export function useIssueClosedChip(task: Task): IssueClosedChipView {
  const issueNumber = task.issueNumber ?? null;
  const visible =
    issueNumber !== null &&
    task.issueState === 'closed' &&
    task.status !== 'done' &&
    !task.merged;

  const open = useCallback(() => {
    if (issueNumber !== null) {
      void openIssueInBrowser(issueNumber).catch((err) =>
        console.error('open_issue_in_browser failed', err),
      );
    }
  }, [issueNumber]);

  return { visible, issueNumber, open };
}
