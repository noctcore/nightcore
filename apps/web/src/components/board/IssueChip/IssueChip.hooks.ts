import { useCallback } from 'react';

import { openIssueInBrowser, type Task } from '@/lib/bridge';

import { issueClosedUpstream } from '../IssueClosedChip';

/** The chip's view: whether it renders, the issue number it names, and the open action. */
export interface IssueChipView {
  /** Render when the task links an issue AND the "closed upstream" chip isn't claiming
   *  the slot — exactly one issue chip ever shows per card/drawer. */
  visible: boolean;
  /** The linked issue number, or `null` when the task links none. */
  issueNumber: number | null;
  /** Open the issue on GitHub in the system browser (READ-ONLY — no task mutation). */
  open: () => void;
}

/** Drive the `issue #N` provenance chip (#402). The read-only counterpart of the shipped
 *  `PR #<n>` chip: same Github icon + `#<n>` + `↗` idiom, same "open it in the system
 *  browser and change nothing" contract (`TaskDetail.hooks.prChipLabel` /
 *  `TaskDetailFooter`). `issueNumber` is the DURABLE linkage stamped at convert time, so
 *  the chip survives run-store pruning.
 *
 *  Defers to `issueClosedUpstream`: while the linked issue is closed upstream and the
 *  task is still open, the louder warning-toned `IssueClosedChip` renders instead, so the
 *  two never stack. State-free (the open handler lives here, per the no-state-in-body
 *  convention). */
export function useIssueChip(task: Task): IssueChipView {
  const issueNumber = task.issueNumber ?? null;
  const visible = issueNumber !== null && !issueClosedUpstream(task);

  const open = useCallback(() => {
    if (issueNumber !== null) {
      void openIssueInBrowser(issueNumber).catch((err) =>
        console.error('open_issue_in_browser failed', err),
      );
    }
  }, [issueNumber]);

  return { visible, issueNumber, open };
}
