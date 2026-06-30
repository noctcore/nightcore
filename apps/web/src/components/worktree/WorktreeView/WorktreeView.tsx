import { DiffViewDialog } from '../DiffViewDialog';
import { DiscardDialog } from '../DiscardDialog';
import { MergePreviewDialog } from '../MergePreviewDialog';
import { WorktreeManager } from '../WorktreeManager';
import { useWorktreeView } from './WorktreeView.hooks';
import type { WorktreeViewProps } from './WorktreeView.types';

/** The standalone worktree manager surface: the worktree list with per-row
 *  diff / merge-preview / discard actions, plus the three review dialogs it
 *  drives. A thin shell — all data + dialog orchestration lives in
 *  `useWorktreeView` (no state in the component body). */
export function WorktreeView({ worktrees, tasks }: WorktreeViewProps) {
  const v = useWorktreeView(tasks, worktrees);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-5">
      <WorktreeManager
        worktrees={worktrees}
        titleForTask={v.titleForTask}
        onViewDiff={v.openDiff}
        onPreviewMerge={v.openPreview}
        onDiscard={v.openDiscard}
      />

      <MergePreviewDialog
        open={v.preview !== null}
        preview={v.preview?.data ?? null}
        loading={v.preview?.loading ?? false}
        merging={v.merging}
        onMerge={v.confirmMerge}
        onClose={v.closePreview}
        onViewDiff={v.onPreviewViewDiff}
      />

      <DiffViewDialog
        open={v.diff !== null}
        diff={v.diff?.data ?? null}
        loading={v.diff?.loading ?? false}
        onClose={v.closeDiff}
      />

      <DiscardDialog
        open={v.discard !== null}
        branch={v.discard?.branch}
        changedFiles={v.discard?.changedFiles}
        discarding={v.discard?.discarding ?? false}
        error={v.discard?.error ?? null}
        onConfirm={v.confirmDiscard}
        onClose={v.closeDiscard}
      />
    </div>
  );
}
