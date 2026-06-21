import type { GauntletResult, Task } from '@/lib/bridge';
import type { SessionStream, ToolLine } from '../session-stream';

export interface TaskDetailView {
  isRunning: boolean;
  /** True while a reviewer session reads the diff (`verifying`). */
  isVerifying: boolean;
  cost: number | null;
  error: string | null;
  answer: string;
  tools: ToolLine[];
  /** A `waiting_approval` parked on a verification verdict (has `review`). */
  reviewParked: boolean;
  /** A `waiting_approval` parked on a plan (`ExitPlanMode`, no verdict yet). */
  planParked: boolean;
  /** Whether the kind picker is editable — only before the task has run. */
  kindEditable: boolean;
  /** Whether the Verified-column gauntlet + merge controls apply (a `done` task). */
  isVerifiedColumn: boolean;
}

/** Resolve the drawer's view-model: the live stream wins over the persisted
 *  task while a run is in flight; otherwise the stored values are shown. The M4
 *  `waiting_approval` split keys on `task.review` — a parked verification carries
 *  the reviewer verdict, a parked plan does not. */
export function deriveTaskDetailView(
  task: Task,
  stream: SessionStream | undefined,
): TaskDetailView {
  const waiting = task.status === 'waiting_approval';
  const reviewParked = waiting && task.review !== null;
  return {
    isRunning: task.status === 'in_progress',
    isVerifying: task.status === 'verifying',
    cost: stream?.costUsd ?? task.costUsd,
    error: stream?.error ?? task.error,
    answer: stream?.answer ?? task.summary ?? '',
    tools: stream?.tools ?? [],
    reviewParked,
    planParked: waiting && !reviewParked,
    kindEditable: task.status === 'backlog' || task.status === 'ready',
    isVerifiedColumn: task.status === 'done',
  };
}

/** Whether Merge is permitted: the pre-merge gate requires a verified task AND a
 *  passing gauntlet (M4 §D). A `main`-mode task (M4.6) edits the project tree in
 *  place with no branch, so it can never merge — `merge_task` refuses it. Until
 *  the gauntlet has been run (`null`), Merge stays disabled — run the checks first. */
export function canMerge(task: Task, gauntlet: GauntletResult | null | undefined): boolean {
  if (task.runMode === 'main') return false;
  return task.verified && gauntlet !== null && gauntlet !== undefined && gauntlet.passed;
}
