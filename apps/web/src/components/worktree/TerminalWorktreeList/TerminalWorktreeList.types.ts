/** Props for the TerminalWorktreeList — the "Terminal worktrees" group (spec PR 5a/5c). */
import type { WorktreeInfo } from '@/lib/bridge';

/** Props for {@link TerminalWorktreeList}. Presentational: the parent (WorktreeView) owns
 *  the list + discard dialog; this panel lists the user-created terminal worktrees and
 *  emits open / discard actions keyed on each worktree. Renders nothing when there are no
 *  terminal worktrees (and no load in flight), so the group appears only when it has
 *  content. */
export interface TerminalWorktreeListProps {
  /** The project's terminal worktrees (from `listTerminalWorktrees`). */
  worktrees: WorktreeInfo[];
  /** Open a terminal in the worktree's directory (spec PR 5b). */
  onOpenTerminal?: (path: string) => void;
  /** Discard the worktree (and its `term/<slug>` branch). Destructive. */
  onDiscard: (worktree: WorktreeInfo) => void;
}
