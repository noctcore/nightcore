/** TaskDetail derivation helpers: build the drawer's view-model from the task +
 *  live transcript, decide whether Merge is permitted, and gate the Create PR
 *  action (eligibility + the lazy `pr_support` capability probe). */
import { createContext, useContext, useEffect, useState } from 'react';

import type { GauntletResult, PrSupport, Task } from '@/lib/bridge';
import { prSupport } from '@/lib/bridge';

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

/** The task-side half of the Create PR eligibility contract: done + verified +
 *  committed + worktree mode, not yet merged, and no PR opened yet. The
 *  capability probe (`pr_support`) only runs for tasks that pass this. */
export function prEligibleTask(task: Task): boolean {
  return (
    task.status === 'done' &&
    task.verified &&
    task.committed &&
    task.runMode === 'worktree' &&
    !task.merged &&
    task.prUrl === undefined
  );
}

/** Whether the Create PR button shows: the full eligibility contract — an
 *  eligible task AND a green capability probe (`gh` installed + an `origin`
 *  remote). A `null` probe (still loading, or not probed) hides the button. */
export function canCreatePr(task: Task, support: PrSupport | null | undefined): boolean {
  if (!prEligibleTask(task)) return false;
  if (support === null || support === undefined) return false;
  return support.ghInstalled && support.remote !== null;
}

/** The PR chip's label once `prUrl` is set — `PR #123`, or a plain `PR` when the
 *  number is (unexpectedly) absent. */
export function prChipLabel(task: Task): string {
  return task.prNumber !== undefined ? `PR #${task.prNumber}` : 'PR';
}

/** A red probe, cached for a task whose `pr_support` call itself failed — the
 *  button hides rather than lying about capability. */
const PROBE_FAILED: PrSupport = { ghInstalled: false, remote: null };

/** Lazily probe PR support (`gh` on PATH + an `origin` remote) for the open
 *  task, only once it passes the task-side eligibility gate, cached per task id
 *  for this drawer's lifetime. `override` (a story/test seam, and unused by the
 *  app shell) skips the probe entirely when provided. */
export function usePrSupport(task: Task, override?: PrSupport | null): PrSupport | null {
  const [cache, setCache] = useState<Record<string, PrSupport>>({});
  const id = task.id;
  const relevant = prEligibleTask(task);
  const cached = cache[id] ?? null;
  const skip = override !== undefined;

  useEffect(() => {
    if (skip || !relevant || cached !== null) return;
    let stale = false;
    void prSupport(id)
      .then((support) => {
        if (!stale) setCache((prev) => ({ ...prev, [id]: support }));
      })
      .catch(() => {
        if (!stale) setCache((prev) => ({ ...prev, [id]: PROBE_FAILED }));
      });
    return () => {
      stale = true;
    };
  }, [skip, relevant, cached, id]);

  return override !== undefined ? override : cached;
}
