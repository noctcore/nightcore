/** WorktreeManager derivation: turn a `WorktreeInfo` into a render-ready row view
 *  (primary task, friendly title, and the status-chip cluster). Pure — no React
 *  state — so the `.tsx` shell stays a thin presentation layer. */
import type { WorktreeInfo } from '@/lib/bridge';

import type { WorktreeChip, WorktreeRowView } from './WorktreeManager.types';

/** Build the ordered status-chip cluster for a worktree: uncommitted changes
 *  (amber), commits ahead of base (emerald), commits behind base (amber), and a
 *  red `diverged` flag when the branch is both ahead AND behind base. */
function statusChips(worktree: WorktreeInfo): WorktreeChip[] {
  const chips: WorktreeChip[] = [];

  if (worktree.dirty || worktree.changedFiles > 0) {
    const n = worktree.changedFiles;
    chips.push({
      key: 'changed',
      tone: 'warning',
      label: n > 0 ? `${n} changed` : 'changed',
      ariaLabel: n > 0 ? `${n} uncommitted changed files` : 'uncommitted changes',
    });
  }

  if (worktree.aheadOfBase > 0) {
    chips.push({
      key: 'ahead',
      tone: 'success',
      label: `↑${worktree.aheadOfBase}`,
      ariaLabel: `${worktree.aheadOfBase} commits ahead of base`,
    });
  }

  if (worktree.behindOfBase > 0) {
    chips.push({
      key: 'behind',
      tone: 'warning',
      label: `↓${worktree.behindOfBase}`,
      ariaLabel: `${worktree.behindOfBase} commits behind base`,
    });
  }

  if (worktree.aheadOfBase > 0 && worktree.behindOfBase > 0) {
    chips.push({
      key: 'diverged',
      tone: 'danger',
      label: 'diverged',
      ariaLabel: 'diverged from base',
      dot: true,
    });
  }

  return chips;
}

/** Derive the render-ready row view for one worktree: its primary task id
 *  (`taskIds[0]`, or `null` when none — actions disable), a friendly task title
 *  via the optional resolver, and the status-chip cluster. */
export function worktreeRowView(
  worktree: WorktreeInfo,
  titleForTask?: (taskId: string) => string | undefined,
): WorktreeRowView {
  const primaryTaskId = worktree.taskIds[0] ?? null;
  const title = primaryTaskId !== null ? titleForTask?.(primaryTaskId) : undefined;

  return {
    branch: worktree.branch,
    title,
    primaryTaskId,
    chips: statusChips(worktree),
  };
}
