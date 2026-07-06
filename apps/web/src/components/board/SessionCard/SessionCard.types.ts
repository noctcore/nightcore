/** Prop types for the Session and History cards. Both read the drawer's grouped
 *  actions from `TaskActionsContext` (`useTaskActions()`), not props. */
import type { Task } from '@/lib/bridge';

/** Props for the collapsible Session card. The card reads the `onChange*` edit
 *  handlers from `TaskActionsContext` and renders editable pickers only when
 *  `kindEditable` AND every edit handler is wired (the shell always provides
 *  them together). */
export interface SessionCardProps {
  task: Task;
  /** Whether the per-task config is still editable (pre-run). Also opens the card
   *  by default at mount so a fresh backlog/ready task surfaces its config. */
  kindEditable: boolean;
}

/** Props for the collapsible History card. The card reads the resume/rename/tag
 *  handlers from `TaskActionsContext`; the parent only renders it once those
 *  handlers are wired. */
export interface HistoryCardProps {
  task: Task;
  /** Whether resume is permitted (no run in flight). */
  canResume: boolean;
}
