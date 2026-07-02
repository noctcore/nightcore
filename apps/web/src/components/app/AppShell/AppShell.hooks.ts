import { useCallback, useMemo } from 'react';

import {
  type ActiveWorktree,
  EMPTY_TRANSCRIPT,
  type TaskDetailActions,
  type TaskTranscript,
} from '@/components/board';
import { useToast } from '@/components/ui';
import {
  acceptReview,
  approveTask,
  cancelTask,
  commitTask,
  convertAllSubtasks,
  convertSubtask,
  type CreatePrOptions,
  createTask,
  type CreateTaskOptions,
  deleteTask,
  type GauntletResult,
  isTauri,
  mergeTask,
  moveTask,
  type PermissionMode,
  type PermissionPrompt,
  type QuestionAnswer,
  type QuestionPrompt,
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
  type WorktreeInfo,
} from '@/lib/bridge';

import { useActionGuard } from './hooks/useActionGuard.hooks';
import { useAutoLoop } from './hooks/useAutoLoop.hooks';
import { useBlockedIds } from './hooks/useBlockedIds.hooks';
import { useBoard } from './hooks/useBoard.hooks';
import { useCreatePr } from './hooks/useCreatePr.hooks';
import { useDestructiveConfirm } from './hooks/useDestructiveConfirm.hooks';
import { useGauntlet } from './hooks/useGauntlet.hooks';
import { useGlobalErrorToast } from './hooks/useGlobalErrorToast.hooks';
import { useNewProjectFlow } from './hooks/useNewProjectFlow.hooks';
import { usePermissions, useQuestions } from './hooks/useParkedPrompts.hooks';
import { useProjectRegistry } from './hooks/useProjectRegistry.hooks';
import { useRouting } from './hooks/useRouting.hooks';
import { useSettingsData } from './hooks/useSettingsData.hooks';
import { useSplash } from './hooks/useSplash.hooks';
import { useStableLogCounts } from './hooks/useStableLogCounts.hooks';
import { useWorktrees } from './hooks/useWorktrees.hooks';

/** Everything the shell renders from: the per-domain hook results (routing,
 *  registry, settings, auto-loop, New Project flow) plus the board controller
 *  augmented with the cross-hook action handlers and derived board state. */
export interface AppShellState {
  routing: ReturnType<typeof useRouting>;
  registry: ReturnType<typeof useProjectRegistry>;
  settings: ReturnType<typeof useSettingsData>;
  autoLoop: ReturnType<typeof useAutoLoop>;
  newProject: ReturnType<typeof useNewProjectFlow>;
  board: ReturnType<typeof useBoard> & {
    anyRunning: boolean;
    selected: Task | null;
    logCounts: Record<string, number>;
    blockedIds: Set<string>;
    /** Parked permission prompts keyed by task id (`nc:permission`). */
    prompts: Record<string, PermissionPrompt[]>;
    /** Parked AskUserQuestion prompts keyed by task id (`nc:question`). */
    questions: Record<string, QuestionPrompt[]>;
    /** Task ids with at least one parked prompt OR question — drives the card's
     *  pulse and the "needs input" affordance. */
    promptIds: Set<string>;
    /** Per-task readiness-gauntlet results, keyed by task id. */
    gauntletResults: Record<string, GauntletResult>;
    /** Task ids with a gauntlet run in flight. */
    gauntletRunning: Set<string>;
    /** The active project's live worktrees for the switcher. */
    worktrees: WorktreeInfo[];
    /** The selected worktree tab (`null` = Main); filters the board. */
    activeWorktree: ActiveWorktree;
    /** Select a worktree tab (sets the active worktree + filters the board). */
    setActiveWorktree: (active: ActiveWorktree) => void;
    handleCreate: (
      title: string,
      description: string,
      kind: TaskKind,
      runMode: RunMode,
      options?: CreateTaskOptions,
    ) => Promise<void>;
    handleRun: (id: string) => void;
    handleCancel: (id: string) => void;
    /** Resume a chosen historical session (relaunches the task at the UUID). */
    handleResumeSession: (taskId: string, sdkSessionId: string) => void;
    /** Rename a past session's title. */
    handleRenameSession: (sdkSessionId: string, title: string) => void;
    /** Tag a past session, or clear its tag with `null`. */
    handleTagSession: (sdkSessionId: string, tag: string | null) => void;
    handleDelete: (id: string) => void;
    handleClearColumn: (statuses: TaskStatus[]) => void;
    handleMoveTask: (id: string, status: TaskStatus) => void;
    handleRespondPermission: (
      taskId: string,
      requestId: string,
      decision: 'allow' | 'deny',
    ) => void;
    /** Answer a parked AskUserQuestion prompt (submit choices or skip). */
    handleAnswerQuestion: (
      taskId: string,
      requestId: string,
      answer: QuestionAnswer,
    ) => void;
    handleApprove: (id: string) => void;
    handleReject: (id: string) => void;
    handleRefine: (id: string) => void;
    handleCommit: (id: string) => void;
    handleMerge: (id: string) => void;
    /** The task id the Create PR dialog is open for (`null` = closed). */
    prDialogTaskId: string | null;
    /** Close the Create PR dialog. */
    closePrDialog: () => void;
    /** The guarded push + `gh pr create` mutation the dialog confirms. Rejects
     *  on failure (the dialog shows the error inline and stays open). */
    handleCreatePr: (id: string, opts: CreatePrOptions) => Promise<void>;
    /** Edit a not-yet-run task's kind. */
    handleChangeKind: (id: string, kind: TaskKind) => void;
    /** Edit a not-yet-run task's run mode. */
    handleChangeRunMode: (id: string, runMode: RunMode) => void;
    /** Edit a not-yet-run task's permission-mode override. */
    handleChangePermissionMode: (id: string, permissionMode: PermissionMode | null) => void;
    /** Edit a not-yet-run task's model override. */
    handleChangeModel: (id: string, model: string | null) => void;
    /** Edit a not-yet-run task's reasoning-effort override. */
    handleChangeEffort: (id: string, effort: string | null) => void;
    /** Edit a not-yet-run task's max-turns ceiling (SDK guardrail). */
    handleChangeMaxTurns: (id: string, maxTurns: number | null) => void;
    /** Edit a not-yet-run task's max-budget-USD ceiling (SDK guardrail). */
    handleChangeMaxBudget: (id: string, maxBudgetUsd: number | null) => void;
    /** Verification-approval actions for a review-parked task. */
    handleAcceptReview: (id: string) => void;
    handleRejectReview: (id: string) => void;
    handleRerunVerification: (id: string) => void;
    /** Run the pre-merge readiness gauntlet for a verified task. */
    handleRunGauntlet: (id: string) => void;
    /** Convert one proposed sub-task into a board task. */
    handleConvertSubtask: (parentId: string, subtaskId: string) => void;
    /** Convert every still-open proposed sub-task into board tasks. */
    handleConvertAllSubtasks: (parentId: string) => void;
    /** True while a guarded task action (`run`/`approve`/`commit`/…) is in flight,
     *  so the matching button can disable itself and not double-fire. */
    isActionPending: (action: string, id: string) => boolean;
    /** The open drawer's ~25 action callbacks pre-assembled into one referentially
     *  stable object, so the memoized `TaskDetailChrome` bails on a stream flush
     *  instead of re-rendering because a fresh `actions` literal arrived each frame. */
    detailActions: TaskDetailActions;
    /** Stable "close the detail drawer" handler (clears the selection). */
    closeDetail: () => void;
    /** Open the destructive-delete confirmation for a card's trash button (the
     *  board wires this as the card `onDelete` so a delete is never immediate). */
    requestDelete: (id: string) => void;
    /** Open the destructive bulk-clear confirmation for a column's Clear button. */
    requestClear: (statuses: TaskStatus[]) => void;
  };
  /** The shared destructive-delete confirmation (card trash + column Clear),
   *  rendered by AppShell as a single `ConfirmDialog`. */
  confirm: ReturnType<typeof useDestructiveConfirm>;
  showSplash: boolean;
  isTauri: boolean;
}

/** The shell's single composition hook: routing, the project registry, settings,
 *  the New Project flow, and the board's task/stream wiring. Each domain hook
 *  lives in its own `./hooks/*` module; this composes them and exposes the cross-
 *  hook action handlers (which bridge the action guard + board state). */
export function useAppShell(): AppShellState {
  const toast = useToast();
  // Last-resort net: surface stray promise rejections (fire-and-forget handlers)
  // through the toast channel instead of letting them die in the console.
  useGlobalErrorToast(toast);
  const action = useActionGuard();
  const showSplash = useSplash();
  const routing = useRouting();
  const registry = useProjectRegistry(toast);
  const settings = useSettingsData(toast);
  const persistConcurrency = useCallback(
    (n: number) => settings.update({ maxConcurrency: n }),
    [settings],
  );
  const autoLoop = useAutoLoop(
    settings.settings?.maxConcurrency ?? 3,
    persistConcurrency,
    toast,
  );
  const newProject = useNewProjectFlow(routing.closeNewProject, toast);
  const board = useBoard(toast);
  const blockedIds = useBlockedIds();
  const { tasks, setTasks, streams, setStreams, selectedId, setSelectedId } = board;
  const permissions = usePermissions(tasks, toast);
  const questions = useQuestions(tasks, toast);
  const gauntlet = useGauntlet(toast);
  const worktrees = useWorktrees();
  const createPr = useCreatePr(action, toast);

  const anyRunning = useMemo(
    () => tasks.some((t) => t.status === 'in_progress' || t.status === 'verifying'),
    [tasks],
  );
  const selected = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId],
  );
  // Streamed log-line count per task, for the running card's Logs badge. Its
  // object identity is stabilized on the count VALUES (not the per-delta `streams`
  // map) so text-only deltas don't churn the memoized Board/Column/TaskCard tree.
  const logCounts = useStableLogCounts(streams);

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
  // surface failures through the toast channel.
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
        commitTask(id).catch((err) => {
          console.error('commit_task failed', err);
          toast.error('Could not commit the worktree', err);
        }),
      ),
    [action, toast],
  );
  const handleMerge = useCallback(
    (id: string) =>
      action.guard('merge', id, () =>
        mergeTask(id).catch((err) => {
          console.error('merge_task failed', err);
          toast.error('Could not merge the branch', err);
        }),
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
  const handleConvertSubtask = useCallback(
    (parentId: string, subtaskId: string) =>
      action.guard('convertSubtask', parentId, () =>
        convertSubtask(parentId, subtaskId).catch((err) => {
          console.error('convert_subtask failed', err);
          toast.error('Could not convert the sub-task', err);
        }),
      ),
    [action, toast],
  );
  const handleConvertAllSubtasks = useCallback(
    (parentId: string) =>
      action.guard('convertAllSubtasks', parentId, () =>
        convertAllSubtasks(parentId).catch((err) => {
          console.error('convert_all_subtasks failed', err);
          toast.error('Could not convert the sub-tasks', err);
        }),
      ),
    [action, toast],
  );

  // Route the card trash + column Clear through a shared destructive confirm
  // (the real deletes stay optimistic; only the trigger is gated).
  const confirm = useDestructiveConfirm(tasks, handleDelete, handleClearColumn);

  const promptIds = useMemo(
    () => new Set([...Object.keys(permissions.prompts), ...Object.keys(questions.prompts)]),
    [permissions.prompts, questions.prompts],
  );

  // Pre-assemble the drawer's grouped action object ONCE from the (individually
  // memoized) handlers, instead of a fresh literal per render. Every dependency is
  // stable across a stream flush: the handlers turn over only when a real input
  // changes (a parked prompt resolving, the toast list, or the action-guard's
  // pending set transitioning) — never on a per-frame `nc:session` delta. This
  // holds ONLY because `useActionGuard` returns a memoized `action`; the guarded
  // handlers below all list `action` in their deps, so an unmemoized `action`
  // would re-identify them (and this object) every render and defeat the memo.
  // With that invariant intact, the memoized TaskDetailChrome bails on a flush.
  const closeDetail = useCallback(() => setSelectedId(null), [setSelectedId]);
  const detailActions = useMemo<TaskDetailActions>(
    () => ({
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
      onResumeSession: handleResumeSession,
      onRenameSession: handleRenameSession,
      onTagSession: handleTagSession,
    }),
    [
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
      handleResumeSession,
      handleRenameSession,
      handleTagSession,
    ],
  );

  return {
    routing,
    registry,
    settings,
    autoLoop,
    newProject,
    board: {
      ...board,
      anyRunning,
      selected,
      logCounts,
      blockedIds,
      prompts: permissions.prompts,
      questions: questions.prompts,
      promptIds,
      gauntletResults: gauntlet.results,
      gauntletRunning: gauntlet.running,
      worktrees: worktrees.worktrees,
      activeWorktree: worktrees.active,
      setActiveWorktree: worktrees.setActive,
      handleCreate,
      handleRun,
      handleCancel,
      handleResumeSession,
      handleRenameSession,
      handleTagSession,
      handleDelete,
      handleClearColumn,
      handleMoveTask,
      handleRespondPermission: permissions.respond,
      handleAnswerQuestion: questions.answer,
      handleApprove,
      handleReject,
      handleRefine,
      handleCommit,
      handleMerge,
      prDialogTaskId: createPr.prDialogTaskId,
      closePrDialog: createPr.closePrDialog,
      handleCreatePr: createPr.create,
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
      handleRunGauntlet: gauntlet.run,
      handleConvertSubtask,
      handleConvertAllSubtasks,
      isActionPending: action.isPending,
      detailActions,
      closeDetail,
      requestDelete: confirm.requestDelete,
      requestClear: confirm.requestClear,
    },
    confirm,
    showSplash,
    isTauri: isTauri(),
  };
}
