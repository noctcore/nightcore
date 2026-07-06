/** Props for the TaskCard component. The card's action handlers (`onSelect` /
 *  `onRun` / `onCancel` / `onDelete` / `onApprove` / `onRefine` / `onCommit` /
 *  `onMerge` / `isActionPending`) come from `TaskActionsContext`
 *  (`useTaskActions()`), not props — only the task + presentational flags travel
 *  down the Board → Column → TaskCard chain. */
import type { Task } from '@/lib/bridge';

/** Props for a single task card: the task and its presentational flags. */
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
}
