import { Badge, BranchIcon, Button, TerminalIcon, TrashIcon } from '@/components/ui';

import { changedLabel, shouldShowGroup } from './TerminalWorktreeList.hooks';
import type { TerminalWorktreeListProps } from './TerminalWorktreeList.types';

/** The "Terminal worktrees" group in the Worktrees view (spec PR 5a/5c): the user-created
 *  worktrees under the separate `term/` namespace, each with "Open terminal" + "Discard"
 *  actions keyed on its path/slug. Purely presentational — the parent owns the list + the
 *  discard dialog. Renders nothing when there are none, so the group only appears when it
 *  has content (no empty-group flash on the common no-terminal-worktrees case). */
export function TerminalWorktreeList({
  worktrees,
  onOpenTerminal,
  onDiscard,
}: TerminalWorktreeListProps) {
  if (!shouldShowGroup(worktrees)) return null;

  return (
    <section className="mt-6 flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <TerminalIcon size={14} className="text-muted-foreground" />
        <h2 className="text-[13px] font-semibold text-foreground">Terminal worktrees</h2>
        <Badge tone="neutral">{worktrees.length}</Badge>
      </header>
      <p className="text-[11px] text-muted-foreground">
        Created from the terminal — a separate <span className="font-mono">term/</span> namespace,
        never touched by the task reconcile sweep. They carry no task and never affect task status.
      </p>

      <ul className="flex flex-col gap-2">
        {worktrees.map((worktree) => {
          const changed = changedLabel(worktree);
          return (
            <li
              key={worktree.path}
              className="flex items-start gap-3 rounded-[10px] border border-border bg-white/[0.02] px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <BranchIcon size={13} className="shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-[12px] text-foreground">
                    {worktree.branch}
                  </span>
                </div>
                {changed !== null && (
                  <div className="mt-1.5">
                    <span className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/[0.12] px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-warning">
                      {changed}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {onOpenTerminal !== undefined && (
                  <Button
                    variant="secondary"
                    onClick={() => onOpenTerminal(worktree.path)}
                    title="Open a terminal in this worktree"
                  >
                    <TerminalIcon size={13} />
                    Terminal
                  </Button>
                )}
                <Button
                  variant="danger"
                  onClick={() => onDiscard(worktree)}
                  title="Discard this terminal worktree and delete its branch"
                >
                  <TrashIcon size={13} />
                  Discard
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
