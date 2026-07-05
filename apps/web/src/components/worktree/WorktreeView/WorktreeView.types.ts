/** Props for the WorktreeView surface. */
import type { Task, WorktreeInfo } from '@/lib/bridge';

/** Props for the standalone worktree manager surface: the live worktrees + the
 *  project's tasks (for friendly titles + branch names). The view owns the dialog
 *  orchestration and bridge actions internally. */
export interface WorktreeViewProps {
  /** The project's live worktrees (from `listWorktrees`). */
  worktrees: WorktreeInfo[];
  /** The project's tasks, for resolving friendly titles + branch names. */
  tasks: Task[];
  /** Reconcile + re-read board/worktree state on demand (the Refresh control):
   *  prune orphans, clear ghost pointers, reclaim merged worktrees. */
  onRefresh: () => void;
}
