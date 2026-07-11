/** Props for the WorktreeView surface. The live worktrees and the Refresh
 *  handler come from the shared `WorktreesContext` (`useWorktreesContext()`),
 *  not props. */
import type { Task } from '@/lib/bridge';

/** Props for the standalone worktree manager surface: the project's tasks (for
 *  friendly titles + branch names). The view owns the dialog orchestration and
 *  bridge actions internally. */
export interface WorktreeViewProps {
  /** The project's tasks, for resolving friendly titles + branch names. */
  tasks: Task[];
  /** Open a terminal in a worktree's directory (spec PR 5b) — routes to the Terminal
   *  view and spawns a shell there. Threaded from the shell (which owns routing); the
   *  "Terminal" per-row action renders only when provided. */
  onOpenTerminal?: (cwd: string) => void;
}
