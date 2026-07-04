import type { ProposedSubtask } from '@/lib/bridge';

export interface ProposedSubtasksPanelProps {
  /** The decompose task's id — the parent of every converted child task. */
  taskId: string;
  /** The sub-tasks the decompose run proposed (parsed from its final message). */
  subtasks: ProposedSubtask[];
  /** Convert one proposal into a board task. Absent → the row is read-only. */
  onConvert?: (parentId: string, subtaskId: string) => void;
  /** Convert every still-open proposal at once. Absent → no bulk action. */
  onConvertAll?: (parentId: string) => void;
  /** True while a convert action is in flight for this task — disables the
   *  buttons so a double-click can't double-convert before the `nc:task` echo. */
  pending?: boolean;
  /** The run's failure message, when the decompose run FAILED (e.g. the SDK
   *  exhausted its structured-output retries). Shown beneath the zero-proposal
   *  notice so a finished-but-empty decompose explains itself instead of rendering
   *  nothing. `null`/absent ⇒ the run finished cleanly with nothing to propose. */
  error?: string | null;
}
