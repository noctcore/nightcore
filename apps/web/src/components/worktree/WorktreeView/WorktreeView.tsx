import { Button, RefreshIcon, Spinner } from '@/components/ui';
import { useWorktreesContext } from '@/lib/worktrees-context';

import { DiffViewDialog } from '../DiffViewDialog';
import { DiscardDialog } from '../DiscardDialog';
import { MergePreviewDialog } from '../MergePreviewDialog';
import { TerminalWorktreeList } from '../TerminalWorktreeList';
import { useTerminalWorktrees } from '../worktree-terminal';
import { WorktreeManager } from '../WorktreeManager';
import { useWorktreeRefresh, useWorktreeView } from './WorktreeView.hooks';
import type { WorktreeViewProps } from './WorktreeView.types';

/** The standalone worktree manager surface: the worktree list with per-row
 *  diff / merge-preview / discard actions, plus the three review dialogs it
 *  drives. A thin shell — all data + dialog orchestration lives in
 *  `useWorktreeView` (no state in the component body). A header Refresh reconciles
 *  + re-reads state on demand so stale entries never require an app restart. */
export function WorktreeView({ tasks, onOpenTerminal }: WorktreeViewProps) {
  const { worktrees, refreshWorktrees } = useWorktreesContext();
  const v = useWorktreeView(tasks, worktrees);
  // Terminal worktrees (spec PR 5): their own list + discard interlock, separate from the
  // task-worktree flow above.
  const term = useTerminalWorktrees();
  const refresh = useWorktreeRefresh(() => {
    refreshWorktrees();
    term.reload();
  });

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-5">
      <div className="mb-4 flex items-center justify-end">
        <Button
          variant="secondary"
          disabled={refresh.refreshing}
          onClick={refresh.onRefresh}
          title="Reconcile + re-read worktree state"
        >
          {refresh.refreshing ? (
            <Spinner size={14} />
          ) : (
            <RefreshIcon size={14} className="text-muted-foreground" />
          )}
          Refresh
        </Button>
      </div>

      <WorktreeManager
        worktrees={worktrees}
        titleForTask={v.titleForTask}
        prForTask={v.prForTask}
        onOpenPr={v.openPr}
        onViewDiff={v.openDiff}
        onPreviewMerge={v.openPreview}
        onDiscard={v.openDiscard}
        onOpenTerminal={onOpenTerminal}
        onReveal={v.reveal}
        onOpenEditor={v.openEditor}
      />

      <TerminalWorktreeList
        worktrees={term.worktrees}
        onOpenTerminal={onOpenTerminal}
        onDiscard={term.openDiscard}
      />

      <MergePreviewDialog
        open={v.preview !== null}
        preview={v.preview?.data ?? null}
        loading={v.preview?.loading ?? false}
        merging={v.merging}
        terminalSessions={v.preview?.terminalSessions.length ?? 0}
        updatingFromBase={v.updatingFromBase}
        onMerge={v.confirmMerge}
        onUpdateFromBase={v.updateFromBase}
        onClose={v.closePreview}
        onViewDiff={v.onPreviewViewDiff}
      />

      <DiffViewDialog
        open={v.diff !== null}
        diff={v.diff?.data ?? null}
        taskId={v.diff?.taskId ?? null}
        loading={v.diff?.loading ?? false}
        onClose={v.closeDiff}
      />

      <DiscardDialog
        open={v.discard !== null}
        branch={v.discard?.branch}
        changedFiles={v.discard?.changedFiles}
        terminalSessions={v.discard?.terminalSessions.length ?? 0}
        discarding={v.discard?.discarding ?? false}
        error={v.discard?.error ?? null}
        onConfirm={v.confirmDiscard}
        onClose={v.closeDiscard}
      />

      {/* Terminal-worktree discard (spec PR 5c): its own dialog instance, gated on the
          cleanup interlock (open sessions are counted + closed before removal). */}
      <DiscardDialog
        open={term.discard !== null}
        branch={term.discard?.branch}
        changedFiles={term.discard?.changedFiles}
        terminalSessions={term.discard?.terminalSessions.length ?? 0}
        discarding={term.discard?.discarding ?? false}
        error={term.discard?.error ?? null}
        onConfirm={term.confirmDiscard}
        onClose={term.closeDiscard}
      />
    </div>
  );
}
