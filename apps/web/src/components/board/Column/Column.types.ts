/** Props for the Column component. The card action handlers come from
 *  `TaskActionsContext` (consumed by `TaskCard` itself), so the column carries
 *  only its header chrome, the tasks it renders, and the drop-target status. */
import type { Task } from '@/lib/bridge';

import type { DependencyChip } from '../Board/Board.utils';

/** Props for a single board column. */
export interface ColumnProps {
  title: string;
  tasks: Task[];
  /** The column's status dot color (oklch). */
  dotColor: string;
  /** When true and the column is non-empty, render a "Clear" affordance. */
  clearable?: boolean;
  selectedId: string | null;
  /** Task ids that are blocked on an unfinished dependency. */
  blockedIds: Set<string>;
  /** Per-task resolved dependency chips (id → title + satisfied) for the blocked
   *  chip; only tasks with dependencies appear, so a dep-free card gets `undefined`.
   *  Defaults to an empty map for presentational stories. */
  dependencyChipsById?: Map<string, DependencyChip[]>;
  /** Task ids with a parked permission prompt — drives the card's pulse. */
  promptIds?: Set<string>;
  /** Streamed log-line counts per task id (for the running card's Logs badge). */
  logCounts: Record<string, number>;
  /** The @dnd-kit droppable id for this column — the status a card dropped here
   *  moves to. `in_progress` (the In Progress column) is a non-droppable target.
   *  Also the column's interactivity flag: the board passes it only when it owns
   *  a live DnD context (`onMoveTask` at `BoardDnd`), so eligible cards render
   *  draggable exactly when a drop could resolve; presentational stories omit it
   *  and cards render non-draggable. */
  dropStatus?: Task['status'];
  emptyText?: string;
  onClear?: () => void;
}
