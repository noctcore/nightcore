import type { Task } from '@/lib/bridge';

export interface ReviewPanelProps {
  task: Task;
  /** Accept the parked verification (user overrides the reviewer → verified). */
  onAccept?: (id: string) => void;
  /** Reject the parked verification (drops back to the backlog). */
  onReject?: (id: string) => void;
  /** Re-dispatch a reviewer session against the current worktree. */
  onRerun?: (id: string) => void;
}
