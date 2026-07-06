import { useCallback, useMemo } from 'react';

import { EMPTY_TRANSCRIPT, type TaskDetailActions, type TaskTranscript } from '@/components/board';
import type { ToastApi } from '@/components/ui';
import {
  acceptReview,
  approveTask,
  cancelTask,
  commitTask,
  convertAllSubtasks,
  convertSubtask,
  createTask,
  type CreateTaskOptions,
  deleteTask,
  mergeTask,
  moveTask,
  refineTask,
  rejectReview,
  rejectTask,
  renameSession,
  rerunVerification,
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
import type { CreatePrController } from './useCreatePr.hooks';
import { useDestructiveConfirm } from './useDestructiveConfirm.hooks';
import type { useGauntlet } from './useGauntlet.hooks';
import type { usePermissions, useQuestions } from './useParkedPrompts.hooks';
import type { PrLifecycleController } from './usePrLifecycle.hooks';

/** The base state + sub-hook results the board's cross-hook action handlers close
 *  over. Passed in from `useAppShell` (which owns the domain hooks) so this module
 *  holds only the ~28 handlers + the drawer's `detailActions` memo, not the wiring. */
export interface BoardActionsDeps {
  board: ReturnType<typeof useBoard>;
  action: ActionGuard;
  toast: ToastApi;
  permissions: ReturnType<typeof usePermissions>;
  questions: ReturnType<typeof useQuestions>;
  gauntlet: ReturnType<typeof useGauntlet>;
  createPr: CreatePrController;
  prLifecycle: PrLifecycleController;
}

/** The board's cross-hook actions: the drawer's grouped `detailActions`, the shared
 *  destructive-delete confirmation, and the two board-owned handlers the shell still
 *  wires directly (`handleCreate` → NewTaskForm, `handleMoveTask` → Board). */
export interface BoardActions {
  detailActions: TaskDetailActions;
  confirm: ReturnType<typeof useDestructiveConfirm>;
  closeDetail: () => void;
  handleCreate: (
    title: string,
    description: string,
    kind: TaskKind,
    runMode: RunMode,
    options?: CreateTaskOptions,
  ) => Promise<void>;
  handleMoveTask: (id: string, status: TaskStatus) => void;
}

/** The board's cross-hook action layer, extracted from `useAppShell` so the shell
 *  composition hook stays a thin router/registry/settings/board-data assembler. Each
 *  handler resolves a parked request or runs a store/git op on the backend; the
 *  authoritative status arrives via `nc:task`. All mutating actions are guarded
 *  against a double-fire and surface failures through the toast channel; the
 *  optimistic edits capture a rollback so a rejected backend call never leaves the
 *  board lying. Every dependency is stable across a `nc:session` stream flush, so the
 *  memoized `detailActions` (and the `TaskActionsProvider` it feeds) bails on a
 *  flush instead of re-identifying each frame. */
export function useBoardActions({
  board,
  action,
  toast,
  permissions,
  questions,
  gauntlet,
  createPr,
  prLifecycle,
}: BoardActionsDeps): BoardActions {
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

  // Plan-approval + commit/merge actions. Each resolves a parked request or runs a
  // git op on the backend; the authoritative status arrives via `nc:task`. All are
  // guarded against a double-fire between click and the command settling, and
  // surface failures through the toast channel. commit/merge ALSO toast on success:
  // unlike approve/reject/refine — which visibly move the card to a new column —
  // their result leaves no board signal, so the toast is the only confirmation the
  // click landed (the PR-lifecycle + WorktreeView `tone: 'success'` convention).
  const handleApprove = useCallback(
    (id: string) =>
      action.guard('approve', id, () =>
        approveTask(id).catch((err) => {
          console.error('approve_task failed', err);
          toast.error('Could not approve the plan', err);
        }),
      ),
    [action, toast],
  );
  const handleReject = useCallback(
    (id: string) =>
      action.guard('reject', id, () =>
        rejectTask(id).catch((err) => {
          console.error('reject_task failed', err);
          toast.error('Could not reject the plan', err);
        }),
      ),
    [action, toast],
  );
  const handleRefine = useCallback(
    (id: string) =>
      action.guard('refine', id, () =>
        refineTask(id).catch((err) => {
          console.error('refine_task failed', err);
          toast.error('Could not refine the plan', err);
        }),
      ),
    [action, toast],
  );
  const handleCommit = useCallback(
    (id: string) =>
      action.guard('commit', id, () =>
        commitTask(id).then(
          () => toast.push({ tone: 'success', title: 'Changes committed' }),
          (err) => {
            console.error('commit_task failed', err);
            toast.error('Could not commit the worktree', err);
          },
        ),
      ),
    [action, toast],
  );
  const handleMerge = useCallback(
    (id: string) =>
      action.guard('merge', id, () =>
        mergeTask(id).then(
          () => toast.push({ tone: 'success', title: 'Branch merged into base' }),
          (err) => {
            console.error('merge_task failed', err);
            toast.error('Could not merge the branch', err);
          },
        ),
      ),
    [action, toast],
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

  const handleAcceptReview = useCallback(
    (id: string) =>
      action.guard('acceptReview', id, () =>
        acceptReview(id).catch((err) => {
          console.error('accept_review failed', err);
          toast.error('Could not accept the review', err);
        }),
      ),
    [action, toast],
  );
  const handleRejectReview = useCallback(
    (id: string) =>
      action.guard('rejectReview', id, () =>
        rejectReview(id).catch((err) => {
          console.error('reject_review failed', err);
          toast.error('Could not reject the review', err);
        }),
      ),
    [action, toast],
  );
  const handleRerunVerification = useCallback(
    (id: string) =>
      action.guard('rerunVerification', id, () =>
        rerunVerification(id).catch((err) => {
          console.error('rerun_verification failed', err);
          toast.error('Could not rerun verification', err);
        }),
      ),
    [action, toast],
  );

  // Convert a proposed sub-task (or all of them) into board tasks.
  // The backend emits `nc:task` for both the new child and the updated parent, so
  // the board + open drawer refresh via the echo — no optimistic local edit needed.
  // Both toast on success: the new card lands in another column (usually off-screen
  // behind the decompose drawer), so the toast is the confirmation the click worked.
  const handleConvertSubtask = useCallback(
    (parentId: string, subtaskId: string) =>
      action.guard('convertSubtask', parentId, () =>
        convertSubtask(parentId, subtaskId).then(
          () => toast.push({ tone: 'success', title: 'Sub-task added to the board' }),
          (err) => {
            console.error('convert_subtask failed', err);
            toast.error('Could not convert the sub-task', err);
          },
        ),
      ),
    [action, toast],
  );
  const handleConvertAllSubtasks = useCallback(
    (parentId: string) =>
      action.guard('convertAllSubtasks', parentId, () =>
        convertAllSubtasks(parentId).then(
          () => toast.push({ tone: 'success', title: 'Sub-tasks added to the board' }),
          (err) => {
            console.error('convert_all_subtasks failed', err);
            toast.error('Could not convert the sub-tasks', err);
          },
        ),
      ),
    [action, toast],
  );

  // Route the card trash + column Clear through a shared destructive confirm
  // (the real deletes stay optimistic; only the trigger is gated).
  const confirm = useDestructiveConfirm(tasks, handleDelete, handleClearColumn);

  // Pre-assemble the drawer's grouped action object ONCE from the (individually
  // memoized) handlers, instead of a fresh literal per render. Every dependency is
  // stable across a stream flush: the handlers turn over only when a real input
  // changes (a parked prompt resolving, the toast list, or the action-guard's
  // pending set transitioning) — never on a per-frame `nc:session` delta. This
  // holds ONLY because `useActionGuard` returns a memoized `action`; the guarded
  // handlers above all list `action` in their deps, so an unmemoized `action`
  // would re-identify them (and this object) every render and defeat the memo.
  // With that invariant intact, the memoized TaskDetailChrome bails on a flush.
  const closeDetail = useCallback(() => setSelectedId(null), [setSelectedId]);
  const detailActions = useMemo<TaskDetailActions>(
    () => ({
      onSelect: setSelectedId,
      onRun: handleRun,
      onCancel: handleCancel,
      onDelete: confirm.requestDelete,
      onRespondPermission: permissions.respond,
      onAnswerQuestion: questions.answer,
      onApprove: handleApprove,
      onReject: handleReject,
      onRefine: handleRefine,
      onChangeKind: handleChangeKind,
      onChangeRunMode: handleChangeRunMode,
      onChangePermissionMode: handleChangePermissionMode,
      onChangeModel: handleChangeModel,
      onChangeEffort: handleChangeEffort,
      onChangeMaxTurns: handleChangeMaxTurns,
      onChangeMaxBudget: handleChangeMaxBudget,
      onAcceptReview: handleAcceptReview,
      onRejectReview: handleRejectReview,
      onRerunVerification: handleRerunVerification,
      onRunGauntlet: gauntlet.run,
      onConvertSubtask: handleConvertSubtask,
      onConvertAllSubtasks: handleConvertAllSubtasks,
      onMerge: handleMerge,
      onCommit: handleCommit,
      onCreatePr: createPr.openPrDialog,
      onOpenPr: createPr.openPr,
      onPushPrUpdates: prLifecycle.pushUpdates,
      onFinalizePr: prLifecycle.finalize,
      onPullBaseFf: prLifecycle.pullBase,
      onAddressPrComments: prLifecycle.addressComments,
      onResumeSession: handleResumeSession,
      onRenameSession: handleRenameSession,
      onTagSession: handleTagSession,
      // Re-identifies only when the guard's pending set transitions — the same
      // cadence the guarded handlers above already turn over on, so including it
      // here adds no extra churn to this object's identity.
      isActionPending: action.isPending,
    }),
    [
      setSelectedId,
      handleRun,
      handleCancel,
      confirm.requestDelete,
      permissions.respond,
      questions.answer,
      handleApprove,
      handleReject,
      handleRefine,
      handleChangeKind,
      handleChangeRunMode,
      handleChangePermissionMode,
      handleChangeModel,
      handleChangeEffort,
      handleChangeMaxTurns,
      handleChangeMaxBudget,
      handleAcceptReview,
      handleRejectReview,
      handleRerunVerification,
      gauntlet.run,
      handleConvertSubtask,
      handleConvertAllSubtasks,
      handleMerge,
      handleCommit,
      createPr.openPrDialog,
      createPr.openPr,
      prLifecycle.pushUpdates,
      prLifecycle.finalize,
      prLifecycle.pullBase,
      prLifecycle.addressComments,
      handleResumeSession,
      handleRenameSession,
      handleTagSession,
      action.isPending,
    ],
  );

  return { detailActions, confirm, closeDetail, handleCreate, handleMoveTask };
}
