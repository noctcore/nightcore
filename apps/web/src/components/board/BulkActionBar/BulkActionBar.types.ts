import type { ReactNode } from 'react';

import type { Task, TaskStatus } from '@/lib/bridge';

import type { BulkVerb } from './BulkActionBar.hooks';

/** Props for {@link BulkActionBar}. The selection arrives via `TaskSelectionContext` and
 *  the per-task verbs via `TaskActionsContext`; only the board-owned status move (the one
 *  handler the Board itself holds as a prop) travels down. */
export interface BulkActionBarProps {
  /** Every task on the board — resolves the selected ids to tasks so the verbs can run in
   *  the coordinator's launch order and count what is actually runnable. */
  tasks: Task[];
  /** Move one task to a status (the same handler the drag-and-drop drop resolves to). */
  onMoveTask: (id: string, status: TaskStatus) => void;
}

/** Props for {@link BulkVerbButton} — one gated verb in the bar. */
export interface BulkVerbButtonProps {
  verb: BulkVerb;
  label: string;
  icon: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
  /** Tooltip shown while the verb is ENABLED (the disabled tooltip is `verb.reason`). */
  title?: string;
}
