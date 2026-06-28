/** Props for the TaskCard component. */
import type { Task } from '@/lib/bridge';

/** Props for a single task card: the task, its presentational flags, and the
 *  optional bridge action handlers wired by the board. */
export interface TaskCardProps {
  task: Task;
  selected: boolean;
  /** True when this backlog task is blocked on an unfinished dependency. */
  blocked?: boolean;
  /** True when the running task has a parked permission prompt — pulses the card
   *  and surfaces a "needs approval" chip. */
  needsApproval?: boolean;
  /** Number of streamed log lines, shown on the running card's Logs action. */
  logCount?: number;
  /** Whether the card can be dragged between columns (@dnd-kit draggable). The
   *  board pins running/verifying cards (they own a live run), so it passes
   *  `false` for them; presentational stories default to `false`. */
  draggable?: boolean;
  /** Internal: this card is the `<DragOverlay>` preview, so it registers its
   *  draggable under a distinct id (never the live source's) to avoid clobbering
   *  the source's @dnd-kit node registration mid-drag. */
  preview?: boolean;
  /** Open the detail drawer (also the card's click target). */
  onSelect: (id: string) => void;
  /** Real bridge actions. Absent in pure presentational stories. */
  onRun?: (id: string) => void;
  onCancel?: (id: string) => void;
  onDelete?: (id: string) => void;
  /** Waiting Approval actions (Approve / Refine). */
  onApprove?: (id: string) => void;
  onRefine?: (id: string) => void;
  /** Verified actions (Commit / Merge). */
  onCommit?: (id: string) => void;
  onMerge?: (id: string) => void;
  /** Whether a named action is in-flight for this card's task (drives disabled
   *  state on buttons while the backend command is pending). */
  isActionPending?: (action: string, id: string) => boolean;
}
