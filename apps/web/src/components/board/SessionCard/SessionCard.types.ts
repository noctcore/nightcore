/** Prop types for the Session and History cards. */
import type { Task } from '@/lib/bridge';

import type { TaskDetailActions } from '../TaskDetail';

/** Props for the collapsible Session card. */
export interface SessionCardProps {
  task: Task;
  /** Whether the per-task config is still editable (pre-run). Also opens the card
   *  by default at mount so a fresh backlog/ready task surfaces its config. */
  kindEditable: boolean;
  /** The drawer's grouped actions — the card reads the `onChange*` edit handlers
   *  from it. The card renders editable pickers only when `kindEditable` AND every
   *  edit handler is wired (the shell always provides them together). */
  actions: TaskDetailActions;
}

/** Props for the collapsible History card. */
export interface HistoryCardProps {
  task: Task;
  /** Whether resume is permitted (no run in flight). */
  canResume: boolean;
  /** The drawer's grouped actions — the card reads the resume/rename/tag handlers
   *  from it. Only rendered by the parent once those handlers are wired. */
  actions: TaskDetailActions;
}
