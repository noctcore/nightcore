import type { Task } from '@/lib/bridge';

export interface ColumnProps {
  title: string;
  tasks: Task[];
  /** The column's status dot color (oklch), from the design palette. */
  dotColor: string;
  /** Roadmap tag rendered beside the column title (e.g. Waiting Approval → M3). */
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
}
