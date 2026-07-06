/** Prop types for the ReviewPanel component. The Accept / Reject / Rerun
 *  handlers come from `TaskActionsContext` (`onAcceptReview` / `onRejectReview` /
 *  `onRerunVerification`), not props. */
import type { Task } from '@/lib/bridge';

/** Props for `ReviewPanel`. */
export interface ReviewPanelProps {
  /** The task whose verification verdict and structure-lock result are rendered. */
  task: Task;
  /** Whether a given review action is in flight (keys: `acceptReview`,
   *  `rejectReview`, `rerunVerification`) — drives the per-button busy state so the
   *  controls match the TaskDetail footer convention (disabled + spinner + label). */
  pending?: (action: string) => boolean;
}
