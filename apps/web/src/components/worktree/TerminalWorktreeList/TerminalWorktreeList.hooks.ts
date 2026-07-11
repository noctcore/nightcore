/** TerminalWorktreeList derivations — pure, no React state, so the `.tsx` stays thin. */
import type { WorktreeInfo } from '@/lib/bridge';

/** The compact "N changed" label for a terminal worktree row, or `null` when clean. */
export function changedLabel(worktree: WorktreeInfo): string | null {
  const n = worktree.changedFiles;
  if (!worktree.dirty && n === 0) return null;
  return n > 0 ? `${n} changed` : 'changed';
}

/** Whether the group should render at all: only when it has content. So an empty group
 *  (the common case — most projects have no terminal worktrees) never flashes on the
 *  Worktrees view; the list pops in when the background read finds any. */
export function shouldShowGroup(worktrees: WorktreeInfo[]): boolean {
  return worktrees.length > 0;
}
