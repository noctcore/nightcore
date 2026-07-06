/** Prop types for the ProposedSubtasksPanel. The convert handlers come from
 *  `TaskActionsContext` (`onConvertSubtask` / `onConvertAllSubtasks`), not props:
 *  an absent handler renders the matching control read-only. */
import type { ProposedSubtask } from '@/lib/bridge';

export interface ProposedSubtasksPanelProps {
  /** The decompose task's id — the parent of every converted child task. */
  taskId: string;
  /** The sub-tasks the decompose run proposed (parsed from its final message). */
  subtasks: ProposedSubtask[];
  /** True while a convert action is in flight for this task — disables the
   *  buttons so a double-click can't double-convert before the `nc:task` echo. */
  pending?: boolean;
  /** The run's failure message, when the decompose run FAILED (e.g. the SDK
   *  exhausted its structured-output retries). Shown beneath the zero-proposal
   *  notice so a finished-but-empty decompose explains itself instead of rendering
   *  nothing. `null`/absent ⇒ the run finished cleanly with nothing to propose. */
  error?: string | null;
}
