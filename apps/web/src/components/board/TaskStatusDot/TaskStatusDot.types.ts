/** Props for the TaskStatusDot component. */
import type { TaskStatus } from '@/lib/bridge';

/** Props for the status dot: the task status (drives color + pulse) and an
 *  optional glow halo. */
export interface TaskStatusDotProps {
  status: TaskStatus;
  /** Render the dot with a glow halo. */
  glow?: boolean;
}
