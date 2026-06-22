import { useState } from 'react';
import type { GauntletResult, Task } from '@/lib/bridge';
import {
  KIND_LABEL,
  modelDisplayName,
  PERMISSION_MODE_LABEL,
  RUN_MODE_LABEL,
} from '../status';
import type { SessionStream, TimelineEntry } from '../session-stream';

export interface TaskDetailView {
  isRunning: boolean;
  /** True while a reviewer session reads the diff (`verifying`). */
  isVerifying: boolean;
  cost: number | null;
  error: string | null;
  /** The unified activity timeline — assistant text turns interleaved with tool
   *  calls in arrival order (replaces the split `answer` + `tools`). */
  entries: TimelineEntry[];
  /** A `waiting_approval` parked on a verification verdict (has `review`). */
  reviewParked: boolean;
  /** A `waiting_approval` parked on a plan (`ExitPlanMode`, no verdict yet). */
  planParked: boolean;
  /** Whether the kind picker is editable — only before the task has run. */
  kindEditable: boolean;
  /** Whether the Done-column gauntlet + merge controls apply (a `done` task). */
  isDoneColumn: boolean;
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
  // A closed task with no live stream falls back to its stored summary, wrapped as
  // a single synthetic text entry so the timeline still renders its final output.
  const fallbackEntries: TimelineEntry[] =
    task.summary !== null && task.summary.trim().length > 0
      ? [{ kind: 'text', id: 0, markdown: task.summary, closed: true }]
      : [];
  return {
    isRunning: task.status === 'in_progress',
    isVerifying: task.status === 'verifying',
    cost: stream?.costUsd ?? task.costUsd,
    error: stream?.error ?? task.error,
    entries: stream?.entries ?? fallbackEntries,
    reviewParked,
    planParked: waiting && !reviewParked,
    kindEditable: task.status === 'backlog' || task.status === 'ready',
    isDoneColumn: task.status === 'done',
  };
}

/** The Session card's collapse state. Collapsed by default; opens once at mount
 *  when the task is still editable (`kindEditable`) so a fresh backlog/ready task
 *  surfaces its config without a click. The initializer runs once — toggling is
 *  never fought by re-renders. */
export function useSessionCard(kindEditable: boolean): {
  open: boolean;
  toggle: () => void;
} {
  const [open, setOpen] = useState(kindEditable);
  return { open, toggle: () => setOpen((v) => !v) };
}

/** A compact middot-joined one-line summary of a task's session configuration,
 *  for the collapsed Session card. Reuses the shared label maps so it stays in
 *  lockstep with the expanded pickers/pills. Pure. */
export function summarizeSession(task: Task): string {
  const permission =
    task.permissionMode !== null ? PERMISSION_MODE_LABEL[task.permissionMode] : 'Inherit';
  const modelEffort =
    modelDisplayName(task.model) + (task.effort !== null ? `·${task.effort}` : '');
  const turns = task.maxTurns !== null ? `${task.maxTurns} turns` : '∞ turns';
  const limits = task.maxBudgetUsd !== null ? `${turns} · $${task.maxBudgetUsd}` : turns;
  return [
    KIND_LABEL[task.kind],
    RUN_MODE_LABEL[task.runMode],
    permission,
    modelEffort,
    limits,
  ].join(' · ');
}

/** Whether Merge is permitted: the pre-merge gate requires a verified task AND a
 *  passing gauntlet (M4 §D). A `main`-mode task (M4.6) edits the project tree in
 *  place with no branch, so it can never merge — `merge_task` refuses it. Until
 *  the gauntlet has been run (`null`), Merge stays disabled — run the checks first. */
export function canMerge(task: Task, gauntlet: GauntletResult | null | undefined): boolean {
  if (task.runMode === 'main') return false;
  return task.verified && gauntlet !== null && gauntlet !== undefined && gauntlet.passed;
}
