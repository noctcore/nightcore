import { GithubIcon } from '@/components/ui';

import { useIssueChip } from './IssueChip.hooks';
import type { IssueChipProps } from './IssueChip.types';

/** The `issue #N` chip (#402) — parity with the shipped `PR #<n>` chip.
 *
 *  A task converted from a GitHub issue carries the issue number durably
 *  (`task.issueNumber`), but nothing surfaced it: the board could show `PR #123 ↗` and
 *  still leave the originating issue invisible. This chip closes that gap with the SAME
 *  contract as the PR chip — Github icon, `#<n>`, a `↗` link affordance, opens in the
 *  system browser, mutates nothing.
 *
 *  Rendered on the task card's action row and in the detail drawer's provenance row.
 *  `stopPropagation` keeps a click from also selecting/dragging the card. Renders nothing
 *  when the task links no issue, or when the warning-toned `IssueClosedChip` is showing
 *  the same issue's divergence instead. */
export function IssueChip({ task }: IssueChipProps) {
  const { visible, issueNumber, open } = useIssueChip(task);
  if (!visible || issueNumber === null) return null;
  return (
    <button
      type="button"
      title="Open the linked GitHub issue in your browser"
      aria-label={`Issue #${issueNumber} — open it on GitHub`}
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
      className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-4xs-plus text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
    >
      <GithubIcon size={11} />
      issue #{issueNumber} ↗
    </button>
  );
}
