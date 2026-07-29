import type { Task } from '@/lib/bridge';

/** Props for {@link RunOrderPanel}. The projection itself arrives via
 *  `RunOrderContext` — only the sheet's open state and the task index travel down. */
export interface RunOrderPanelProps {
  open: boolean;
  /** Every task on the board — resolves the projection's task ids to titles/statuses. */
  tasks: Task[];
  onClose: () => void;
  /** Open a task's detail drawer from its row (the board's `onSelect`). Omit to render
   *  the rows non-interactive (presentational stories). */
  onSelectTask?: (id: string) => void;
}

/** One rendered row of the "next up" list: the projection entry joined with the task it
 *  names, plus the blockers resolved to titles. */
export interface RunOrderRow {
  id: string;
  title: string;
  position: number;
  wave: number;
  startsNow: boolean;
  /** Human titles of the dependencies not yet satisfied (ids that no longer resolve read
   *  as "a deleted task", matching the card's blocked chip). */
  blockedBy: string[];
}
