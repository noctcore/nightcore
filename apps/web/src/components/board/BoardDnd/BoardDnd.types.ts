import type { ReactNode } from 'react';

import type { Task } from '@/lib/bridge';

/** Props for {@link BoardDnd}. */
export interface BoardDndProps {
  /** All in-scope tasks — used to resolve a dragged card's current status and to
   *  render the drag overlay preview by id. */
  tasks: Task[];
  /** Move a card to a column's status when it's dropped on a different column. */
  onMoveTask: (id: string, status: Task['status']) => void;
  /** The columns row: the droppable columns and their draggable cards. */
  children: ReactNode;
}
