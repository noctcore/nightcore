/** Prop types for the Board component. */
import type { Task } from '@/lib/bridge';

/** Props for the Board: the tasks, project identity, selection/meta, and the
 *  three handlers the board itself owns (new task, drag-move, column clear).
 *  Everything else arrives by context: the per-card action handlers via
 *  `TaskActionsContext` (consumed by `TaskCard`), the worktree cluster via
 *  `WorktreesContext` (the switcher + the board filter), and the header/banner
 *  chrome (appearance + auto-loop) via `BoardChromeContext` (the `BoardHeader`
 *  and the breaker banner). */
export interface BoardProps {
  tasks: Task[];
  /** Active project id — scopes the per-project board background/appearance. */
  projectId: string;
  /** Active project name + path + branch for the header (and the inspector). */
  projectName: string;
  projectPath: string;
  projectBranch: string | null;
  selectedId: string | null;
  /** Streamed log-line counts per task id (running card Logs badge). */
  logCounts: Record<string, number>;
  /** Backend-computed blocked-task ids (deps unsatisfied). Drives the blocked
   *  chip + locked Run; owned by the shell so it refreshes on `nc:task`. */
  blockedIds: Set<string>;
  /** Task ids with a parked permission prompt — drives the card's pulse. */
  promptIds: Set<string>;
  onNewTask: () => void;
  /** Drag a card to another column → set its status (rejected into In Progress). */
  onMoveTask: (id: string, status: Task['status']) => void;
  /** Clear all tasks in a column (Verified/Failed). */
  onClearColumn: (statuses: Task['status'][]) => void;
}
