/** Props for the Column component. */
import type { Task } from '@/lib/bridge';

/** Props for a single board column: its header chrome, the tasks it renders, the
 *  drop target status, and the card action handlers it forwards. */
export interface ColumnProps {
  title: string;
  tasks: Task[];
  /** The column's status dot color (oklch). */
  dotColor: string;
  /** Tag rendered beside the column title (a not-yet-built/future affordance). */
  badge?: string;
  /** When true and the column is non-empty, render a "Clear" affordance. */
  clearable?: boolean;
  selectedId: string | null;
  /** Task ids that are blocked on an unfinished dependency. */
  blockedIds: Set<string>;
  /** Task ids with a parked permission prompt — drives the card's pulse. */
  promptIds?: Set<string>;
  /** Streamed log-line counts per task id (for the running card's Logs badge). */
  logCounts: Record<string, number>;
  /** The @dnd-kit droppable id for this column — the status a card dropped here
   *  moves to. `in_progress` (the In Progress column) is a non-droppable target. */
  dropStatus?: Task['status'];
  emptyText?: string;
  onSelect: (id: string) => void;
  onRun?: (id: string) => void;
  onCancel?: (id: string) => void;
  onDelete?: (id: string) => void;
  /** Present when the board is interactive — gates whether eligible cards are
   *  draggable. The cross-column move itself resolves at the board's `onDragEnd`,
   *  not here. Absent in presentational stories (cards render non-draggable). */
  onMoveTask?: (id: string, status: Task['status']) => void;
  /** Waiting Approval card actions. */
  onApprove?: (id: string) => void;
  onRefine?: (id: string) => void;
  /** Verified card actions. */
  onCommit?: (id: string) => void;
  onMerge?: (id: string) => void;
  onClear?: () => void;
  isActionPending?: (action: string, id: string) => boolean;
}
