/** Props for the TaskCard component. The card's action handlers (`onSelect` /
 *  `onRun` / `onCancel` / `onDelete` / `onApprove` / `onRefine` / `onCommit` /
 *  `onMerge` / `isActionPending`) come from `TaskActionsContext`
 *  (`useTaskActions()`), the projected run order from `RunOrderContext`, and the
 *  multi-select set from `TaskSelectionContext` — not props. Only the task +
 *  presentational flags travel down the Board → Column → TaskCard chain. */
import type { Task } from '@/lib/bridge';

import type { DependencyChip } from '../Board/Board.utils';

/** Props for a single task card: the task and its presentational flags. */
export interface TaskCardProps {
  task: Task;
  selected: boolean;
  /** True when this backlog task is blocked on an unfinished dependency. */
  blocked?: boolean;
  /** The task's resolved dependencies (id → title + satisfied), for the human-readable
   *  blocked chip. `undefined`/empty when the task declares no dependencies. */
  blockedBy?: DependencyChip[];
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

/** The card's run-order chip (#402): where this task sits in the coordinator's projected
 *  execution order. `null` on the card when the task isn't launchable (or the projection
 *  hasn't loaded), so no chip renders. */
export interface TaskCardOrder {
  /** Compact chip text — `next` for the head, else `#N`. */
  label: string;
  /** Full explanation: the position, the wave, and whether it starts on the next tick. */
  tooltip: string;
  /** True when the next auto-loop tick launches this task (projection wave 0). */
  startsNow: boolean;
}

/** The derived view `useTaskCardView` returns — already-computed scalars the card body
 *  and its `.parts.tsx` render without re-deriving anything. */
export interface TaskCardView {
  badge: { label: string; dotColor: string };
  gate: { enabled: boolean; reason: string | null };
  depChip: { label: string; tooltip: string };
  /** Run-order position chip, or `null` when the task has no projected position. */
  order: TaskCardOrder | null;
  /** Show the branch chip: a worktree task's branch, once the run has settled. */
  showBranch: boolean;
  /** Show the "main" chip: a main-mode task edits the tree in place (no branch). */
  showMainChip: boolean;
  /** The attention ring: a needs-approval pulse, else a verifying pulse, else none. */
  pulse: string;
  /** True when this card is part of the board's multi-select. */
  bulkSelected: boolean;
  /** Toggle this card's multi-select membership. */
  onToggleBulk: () => void;
}

/** Props for the card's chip row (`TaskCard.parts.tsx`). */
export interface TaskCardChipsProps {
  task: Task;
  view: TaskCardView;
  blocked: boolean;
  needsApproval: boolean;
}

/** Props for the card's multi-select toggle (`TaskCard.parts.tsx`). */
export interface TaskSelectToggleProps {
  /** The task title — the toggle's accessible name (`Select task <title>`). */
  title: string;
  selected: boolean;
  onToggle: () => void;
}
