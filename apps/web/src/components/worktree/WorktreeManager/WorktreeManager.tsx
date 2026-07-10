/** The standalone worktree manager surface: lists the project's live worktrees
 *  with rich per-row status (changed / ahead / behind / diverged) and per-row
 *  actions (View diff / Merge / Discard). Pure presentational — the parent
 *  (AppShell) owns the data and the dialogs; this panel only emits action
 *  callbacks keyed on each worktree's primary task. */
import { Badge, BranchIcon, EmptyState, Spinner } from '@/components/ui';

import { worktreeRowView } from './WorktreeManager.hooks';
import { WorktreeRow } from './WorktreeManager.parts';
import type { WorktreeManagerProps } from './WorktreeManager.types';

export function WorktreeManager({
  worktrees,
  titleForTask,
  prForTask,
  onOpenPr,
  loading = false,
  onViewDiff,
  onPreviewMerge,
  onDiscard,
  onReveal,
  onOpenEditor,
}: WorktreeManagerProps) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <BranchIcon size={14} className="text-muted-foreground" />
        <h2 className="text-[13px] font-semibold text-foreground">Worktrees</h2>
        <Badge tone="neutral">{worktrees.length}</Badge>
      </header>

      {loading ? (
        <div
          role="status"
          aria-label="Loading worktrees"
          className="flex items-center justify-center py-10 text-muted-foreground"
        >
          <Spinner size={20} />
        </div>
      ) : worktrees.length === 0 ? (
        <EmptyState
          icon={<BranchIcon size={26} />}
          title="No active worktrees"
          description="Tasks set to worktree mode create an isolated branch and worktree here."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {worktrees.map((worktree) => (
            <WorktreeRow
              key={worktree.branch}
              view={worktreeRowView(worktree, titleForTask, prForTask)}
              onOpenPr={onOpenPr}
              onViewDiff={onViewDiff}
              onPreviewMerge={onPreviewMerge}
              onDiscard={onDiscard}
              onReveal={onReveal}
              onOpenEditor={onOpenEditor}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
