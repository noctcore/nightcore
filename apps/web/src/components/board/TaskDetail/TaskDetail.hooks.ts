/** TaskDetail derivation helpers: build the drawer's view-model from the task +
 *  live transcript, and decide whether Merge is permitted. */
import { createContext, useContext } from 'react';

import type { GauntletResult, Task } from '@/lib/bridge';

import { EMPTY_STREAM, type SessionGroup, type TaskTranscript } from '../session-stream';

/** Carries the open task's live per-session transcript from the drawer's outer
 *  `TaskDetail` (which re-renders on every rAF stream flush) down to the
 *  `<ActivityLog>` buried inside the memoized `TaskDetailChrome`. Feeding the
 *  fast-changing stream through context — rather than a prop — lets the chrome
 *  memo bail on a flush while the activity timeline still updates, so only the
 *  log the user is watching reconciles at 60fps, not the whole drawer subtree. */
export const TaskStreamContext = createContext<SessionGroup[]>([]);

/** Read the open task's live session groups from {@link TaskStreamContext}. */
export function useTaskStreamSessions(): SessionGroup[] {
  return useContext(TaskStreamContext);
}

/** The drawer's derived view-model: live run flags, aggregated cost/error, the
 *  per-session timeline, and which control bands apply for this task's status. */
export interface TaskDetailView {
  isRunning: boolean;
  /** True while a reviewer session reads the diff (`verifying`). */
  isVerifying: boolean;
  cost: number | null;
  error: string | null;
  /** The transcript grouped by session — each session's activity timeline is
   *  rendered as its own collapsible block, so a task's in-progress build run and
   *  its later verification run both stay visible (instead of the build being
   *  wiped by the verification session). */
  sessions: SessionGroup[];
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
 *  task while a run is in flight; otherwise the stored values are shown. The
 *  `waiting_approval` split keys on `task.review` — a parked verification carries
 *  the reviewer verdict, a parked plan does not. */
export function deriveTaskDetailView(
  task: Task,
  stream: TaskTranscript | undefined,
): TaskDetailView {
  const waiting = task.status === 'waiting_approval';
  const reviewParked = waiting && task.review !== null;
  const liveSessions = stream?.sessions ?? [];
  // A closed task with no transcript falls back to its stored summary (or its
  // persisted failure), wrapped as a single synthetic session so the timeline
  // still renders the final output / error.
  const hasSummary = task.summary !== null && task.summary.trim().length > 0;
  const hasError = task.error !== null && task.error.trim().length > 0;
  const sessions: SessionGroup[] =
    liveSessions.length > 0
      ? liveSessions
      : hasSummary || hasError
        ? [
            {
              index: 1,
              sdkSessionId: task.sdkSessionId,
              model: task.model,
              prompt: null,
              phase: 'build',
              stream: {
                ...EMPTY_STREAM,
                entries: hasSummary
                  ? [{ kind: 'text', id: 0, markdown: task.summary as string, closed: true }]
                  : [],
                error: task.error,
                costUsd: task.costUsd,
              },
            },
          ]
        : [];
  // Aggregate cost across sessions (each `session-completed` carries its own
  // `costUsd`); fall back to the task's persisted total.
  const streamCost = liveSessions.reduce<number | null>(
    (acc, s) => (s.stream.costUsd !== null ? (acc ?? 0) + s.stream.costUsd : acc),
    null,
  );
  // The most recent session's error surfaces the active failure.
  const lastError = liveSessions[liveSessions.length - 1]?.stream.error ?? null;
  return {
    isRunning: task.status === 'in_progress',
    isVerifying: task.status === 'verifying',
    cost: streamCost ?? task.costUsd,
    error: lastError ?? task.error,
    sessions,
    reviewParked,
    planParked: waiting && !reviewParked,
    kindEditable: task.status === 'backlog' || task.status === 'ready',
    isDoneColumn: task.status === 'done',
  };
}

/** Whether Merge is permitted: the pre-merge gate requires a verified task AND a
 *  passing gauntlet. A `main`-mode task edits the project tree in
 *  place with no branch, so it can never merge — `merge_task` refuses it. Until
 *  the gauntlet has been run (`null`), Merge stays disabled — run the checks first. */
export function canMerge(task: Task, gauntlet: GauntletResult | null | undefined): boolean {
  if (task.runMode === 'main') return false;
  return task.verified && gauntlet !== null && gauntlet !== undefined && gauntlet.passed;
}
