import type { TaskStatus } from '@/lib/bridge';

export interface TaskStatusDotProps {
  status: TaskStatus;
  glow?: boolean;
}
