import type { Task } from '@/lib/bridge';

export interface TaskAttachmentsProps {
  task: Task;
  /** Whether the task is pre-run — when true, images can be added/removed; when
   *  false the grid is read-only (the task has run). */
  editable: boolean;
}
