import { useCallback, useMemo } from 'react';

import { EMPTY_TRANSCRIPT, type TaskTranscript } from '@/components/board';
import type { ToastApi } from '@/components/ui';
import {
  cancelTask,
  createTask,
  type CreateTaskOptions,
  deleteTask,
  moveTask,
  renameSession,
  resumeSession,
  type RunMode,
  runTask,
  tagSession,
  type Task,
  type TaskKind,
  type TaskPatch,
  type TaskStatus,
  updateTask,
} from '@/lib/bridge';

import type { ActionGuard } from './useActionGuard.hooks';
import type { useBoard } from './useBoard.hooks';

/** The board state + guards the task-lifecycle handlers close over. `board` owns the
 *  optimistic state setters (task list, streams, selection); `action` single-flights
 *  the run/session commands; `toast` is the failure channel. */
export interface TaskLifecycleDeps {
  board: ReturnType<typeof useBoard>;
  action: ActionGuard;
  toast: ToastApi;
}

/** The board's OPTIMISTIC task-lifecycle actions: create/run/cancel, the session
 *  resume/rename/tag handlers, delete + column-clear, drag-move, and the not-yet-run
 *  field edits. Each mutates the board's local state up front and captures a rollback
 *  (or resets the stream) so a rejected backend call never leaves the board lying;
 *  the authoritative status arrives via `nc:task`. Split out of `useBoardActions` so
 *  the state-touching handlers sit apart from the guarded workflow gates
 *  (`useTaskWorkflowActions`), and every handler here stays stable across a
 *  `nc:session` stream flush. */
export function useTaskLifecycleActions({ board, action, toast }: TaskLifecycleDeps) {
  const { tasks, setTasks, setStreams, setSelectedId } = board;

  const handleCreate = useCallback(
    async (
      title: string,
      description: string,
      kind: TaskKind,
      runMode: RunMode,
      options: CreateTaskOptions = {},
    ) => {
      try {
        const task = await createTask(title, description, kind, runMode, options);
        setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev : [...prev, task]));
        setSelectedId(task.id);
      } catch (err) {
        console.error('create_task failed', err);
        toast.error('Could not create task', err);
        // Rethrow so the dialog stays open for a retry (see NewTaskForm).
        throw err;
      }
    },
    [setTasks, setSelectedId, toast],
  );

  const handleRun = useCallback(
    (id: string) => {
      // Optimistically reset the stream; guard against a double-fire between the
      // click and the run being accepted.
      action.guard('run', id, () => {
        setStreams((prev) => ({ ...prev, [id]: { ...EMPTY_TRANSCRIPT } }));
        return runTask(id).catch((err) => {
          console.error('run_task failed', err);
          toast.error('Could not start the run', err);
        });
      });
    },
    [action, setStreams, toast],
  );

  const handleCancel = useCallback(
    (id: string) => {
      void cancelTask(id).catch((err) => {
        console.error('cancel_task failed', err);
        toast.error('Could not cancel the run', err);
      });
    },
    [toast],
  );

  const handleResumeSession = useCallback(
    (taskId: string, sdkSessionId: string) => {
      // Optimistically reset the stream (the resumed run streams fresh), guarded
      // against a double-fire like a normal run.
      action.guard('run', taskId, () => {
        setStreams((prev) => ({ ...prev, [taskId]: { ...EMPTY_TRANSCRIPT } }));
        return resumeSession(taskId, sdkSessionId).catch((err) => {
          console.error('resume_session failed', err);
          toast.error('Could not resume the session', err);
        });
      });
    },
    [action, setStreams, toast],
  );

  const handleRenameSession = useCallback(
    (sdkSessionId: string, title: string) => {
      void renameSession(sdkSessionId, title).catch((err) => {
        console.error('rename_session failed', err);
        toast.error('Could not rename the session', err);
      });
    },
    [toast],
  );

  const handleTagSession = useCallback(
    (sdkSessionId: string, tag: string | null) => {
      void tagSession(sdkSessionId, tag).catch((err) => {
        console.error('tag_session failed', err);
        toast.error('Could not tag the session', err);
      });
    },
    [toast],
  );

  // Optimistically drop a task from the board (card, stream transcript, and the
  // selection if it was selected) and return a `rollback` thunk that re-inserts it
  // at its original position. Mirrors the capture-then-restore discipline of
  // handleMoveTask/makeFieldUpdater so a backend delete that REJECTS never leaves a
  // phantom-deleted card (a row gone from the UI but still alive in the store).
  const removeTaskLocally = useCallback(
    (id: string): (() => void) => {
      let removed: { task: Task; index: number } | undefined;
      let removedStream: TaskTranscript | undefined;
      let wasSelected = false;

      setTasks((prev) => {
        const index = prev.findIndex((t) => t.id === id);
        const task = index === -1 ? undefined : prev[index];
        if (task === undefined) return prev;
        removed = { task, index };
        return prev.filter((t) => t.id !== id);
      });
      setStreams((prev) => {
        const stream = prev[id];
        if (stream === undefined) return prev;
        removedStream = stream;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setSelectedId((cur) => {
        if (cur !== id) return cur;
        wasSelected = true;
        return null;
      });

      return () => {
        if (removed !== undefined) {
          const { task, index } = removed;
          setTasks((prev) =>
            // A `nc:task` echo may already have re-added it; never duplicate.
            prev.some((t) => t.id === id)
              ? prev
              : [...prev.slice(0, index), task, ...prev.slice(index)],
          );
        }
        if (removedStream !== undefined) {
          const stream = removedStream;
          setStreams((prev) => (id in prev ? prev : { ...prev, [id]: stream }));
        }
        if (wasSelected) setSelectedId((cur) => (cur === null ? id : cur));
      };
    },
    [setTasks, setStreams, setSelectedId],
  );

  const handleDelete = useCallback(
    (id: string) => {
      // Optimistically remove, capturing a rollback so a rejected backend delete
      // re-inserts the card instead of showing a phantom deletion.
      const rollback = removeTaskLocally(id);
      void deleteTask(id).catch((err) => {
        console.error('delete_task failed', err);
        toast.error('Could not delete task', err);
        rollback();
      });
    },
    [removeTaskLocally, toast],
  );

  const handleClearColumn = useCallback(
    (statuses: TaskStatus[]) => {
      const targets = tasks.filter((t) => statuses.includes(t.status));
      // Same optimistic-with-rollback discipline as handleDelete, per task: a
      // delete that rejects re-inserts just that card, so a partial bulk-clear
      // failure can't strand phantom-deleted tasks on the board.
      for (const t of targets) {
        const rollback = removeTaskLocally(t.id);
        void deleteTask(t.id).catch((err) => {
          console.error('delete_task failed', err);
          toast.error('Could not delete task', err);
          rollback();
        });
      }
    },
    [tasks, removeTaskLocally, toast],
  );

  // Drag-move between columns: optimistically retag the card, then call the
  // backend. The `nc:task` echo reconciles the authoritative status; on failure
  // we roll back to the previous status so the board never lies. We skip the
  // optimistic retag for an in-flight task — a concurrent run's `nc:task`
  // stream owns its status and the move would race it; let the backend decide.
  const handleMoveTask = useCallback(
    (id: string, status: TaskStatus) => {
      let prevStatus: TaskStatus | undefined;
      let inFlight = false;
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t;
          if (t.status === 'in_progress' || t.status === 'verifying') {
            inFlight = true;
            return t;
          }
          prevStatus = t.status;
          return { ...t, status };
        }),
      );
      void moveTask(id, status).catch((err) => {
        console.error('move_task failed', err);
        toast.error('Could not move task', err);
        if (inFlight || prevStatus === undefined) return;
        setTasks((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: prevStatus as TaskStatus } : t)),
        );
      });
    },
    [setTasks, toast],
  );

  // Not-yet-run field edits collapse into one factory: each optimistically
  // patches the field, persists via `update_task`, and ROLLS BACK to the prior
  // value on failure (mirroring handleMoveTask) so a rejected edit can't leave the
  // board lying. `makeFieldUpdater<K>` keeps the seven edits byte-identical.
  const makeFieldUpdater = useCallback(
    <K extends keyof Task & keyof TaskPatch>(field: K) =>
      (id: string, value: Task[K]) => {
        let prevValue: Task[K] | undefined;
        let found = false;
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== id) return t;
            prevValue = t[field];
            found = true;
            return { ...t, [field]: value };
          }),
        );
        void updateTask(id, { [field]: value } as TaskPatch).catch((err) => {
          console.error('update_task failed', err);
          toast.error('Could not update task', err);
          if (!found) return;
          setTasks((prev) =>
            prev.map((t) => (t.id === id ? { ...t, [field]: prevValue as Task[K] } : t)),
          );
        });
      },
    [setTasks, toast],
  );

  const handleChangeKind = useMemo(() => makeFieldUpdater('kind'), [makeFieldUpdater]);
  const handleChangeRunMode = useMemo(() => makeFieldUpdater('runMode'), [makeFieldUpdater]);
  const handleChangePermissionMode = useMemo(
    () => makeFieldUpdater('permissionMode'),
    [makeFieldUpdater],
  );
  const handleChangeModel = useMemo(() => makeFieldUpdater('model'), [makeFieldUpdater]);
  const handleChangeEffort = useMemo(() => makeFieldUpdater('effort'), [makeFieldUpdater]);
  const handleChangeMaxTurns = useMemo(() => makeFieldUpdater('maxTurns'), [makeFieldUpdater]);
  const handleChangeMaxBudget = useMemo(
    () => makeFieldUpdater('maxBudgetUsd'),
    [makeFieldUpdater],
  );

  return {
    handleCreate,
    handleRun,
    handleCancel,
    handleResumeSession,
    handleRenameSession,
    handleTagSession,
    handleDelete,
    handleClearColumn,
    handleMoveTask,
    handleChangeKind,
    handleChangeRunMode,
    handleChangePermissionMode,
    handleChangeModel,
    handleChangeEffort,
    handleChangeMaxTurns,
    handleChangeMaxBudget,
  };
}

/** The optimistic task-lifecycle action layer returned by
 *  {@link useTaskLifecycleActions}. */
export type TaskLifecycleActions = ReturnType<typeof useTaskLifecycleActions>;
