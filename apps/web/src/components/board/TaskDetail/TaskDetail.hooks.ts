import type { Task } from '@/lib/bridge';
import type { SessionStream, ToolLine } from '../session-stream';

export interface TaskDetailView {
  isRunning: boolean;
  cost: number | null;
  error: string | null;
  answer: string;
  tools: ToolLine[];
}

/** Resolve the drawer's view-model: the live stream wins over the persisted
 *  task while a run is in flight; otherwise the stored values are shown. */
export function deriveTaskDetailView(
  task: Task,
  stream: SessionStream | undefined,
): TaskDetailView {
  return {
    isRunning: task.status === 'in_progress',
    cost: stream?.costUsd ?? task.costUsd,
    error: stream?.error ?? task.error,
    answer: stream?.answer ?? task.summary ?? '',
    tools: stream?.tools ?? [],
  };
}
