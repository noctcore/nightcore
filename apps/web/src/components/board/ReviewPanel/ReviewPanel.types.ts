/** Prop types for the ReviewPanel component. */
import type { Task } from '@/lib/bridge';

/** Props for `ReviewPanel`. */
export interface ReviewPanelProps {
  /** The task whose verification verdict and structure-lock result are rendered. */
  task: Task;
  /** Accept the parked verification (user overrides the reviewer → verified). */
  onAccept?: (id: string) => void;
  /** Reject the parked verification (drops back to the backlog). */
  onReject?: (id: string) => void;
  /** Re-dispatch a reviewer session against the current worktree. */
  onRerun?: (id: string) => void;
  /** Whether a given review action is in flight (keys: `acceptReview`,
   *  `rejectReview`, `rerunVerification`) — drives the per-button busy state so the
   *  controls match the TaskDetail footer convention (disabled + spinner + label). */
  pending?: (action: string) => boolean;
}
