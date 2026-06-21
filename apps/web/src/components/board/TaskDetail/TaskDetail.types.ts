import type { Task } from '@/lib/bridge';
import type { SessionStream } from '../session-stream';

export interface TaskDetailProps {
  task: Task;
  stream: SessionStream | undefined;
  /** True when ANY task is in_progress (serial-run guard). */
  anyRunning: boolean;
  onClose: () => void;
  onRun: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
}
