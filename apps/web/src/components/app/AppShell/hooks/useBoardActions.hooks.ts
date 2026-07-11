import { useCallback, useMemo } from 'react';

import { type TaskDetailActions } from '@/components/board';
import type { ToastApi } from '@/components/ui';
import type { CreateTaskOptions, RunMode, TaskKind, TaskStatus } from '@/lib/bridge';

import type { ActionGuard } from './useActionGuard.hooks';
import type { useBoard } from './useBoard.hooks';
import type { CreatePrController } from './useCreatePr.hooks';
import { useDestructiveConfirm } from './useDestructiveConfirm.hooks';
import type { useGauntlet } from './useGauntlet.hooks';
import type { usePermissions, useQuestions } from './useParkedPrompts.hooks';
import type { PrLifecycleController } from './usePrLifecycle.hooks';
import { useTaskLifecycleActions } from './useTaskLifecycleActions.hooks';
import { useTaskWorkflowActions } from './useTaskWorkflowActions.hooks';

/** The base state + sub-hook results the board's cross-hook action handlers close
 *  over. Passed in from `useAppShell` (which owns the domain hooks) so this module
 *  holds only the composition — the two action layers, the shared destructive
 *  confirm, and the drawer's `detailActions` memo — not the wiring. */
export interface BoardActionsDeps {
  board: ReturnType<typeof useBoard>;
  action: ActionGuard;
  toast: ToastApi;
  permissions: ReturnType<typeof usePermissions>;
  questions: ReturnType<typeof useQuestions>;
  gauntlet: ReturnType<typeof useGauntlet>;
  createPr: CreatePrController;
  prLifecycle: PrLifecycleController;
  /** Open a task's linked terminal (cockpit spec PR 4, decision 2): route to the
   *  Terminal view + activate the session. Stable across stream flushes. */
  onOpenTerminal: (sessionId: string) => void;
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
 *  composition hook stays a thin router/registry/settings/board-data assembler. This
 *  hook itself is now a thin composition seam: it draws the optimistic task-lifecycle
 *  handlers from `useTaskLifecycleActions` and the guarded workflow gates from
 *  `useTaskWorkflowActions`, wires the shared destructive confirm, and pre-assembles
 *  the drawer's `detailActions` memo. Every dependency is stable across a `nc:session`
 *  stream flush, so the memoized `detailActions` (and the `TaskActionsProvider` it
 *  feeds) bails on a flush instead of re-identifying each frame. */
export function useBoardActions({
  board,
  action,
  toast,
  permissions,
  questions,
  gauntlet,
  createPr,
  prLifecycle,
  onOpenTerminal,
}: BoardActionsDeps): BoardActions {
  const { tasks, setSelectedId } = board;

  // The optimistic (board-state-touching) lifecycle actions and the guarded
  // (echo-settled) workflow gates, each its own cohesive hook.
  const lifecycle = useTaskLifecycleActions({ board, action, toast });
  const workflow = useTaskWorkflowActions({ action, toast });

  // Route the card trash + column Clear through a shared destructive confirm
  // (the real deletes stay optimistic; only the trigger is gated).
  const confirm = useDestructiveConfirm(tasks, lifecycle.handleDelete, lifecycle.handleClearColumn);

  // Pre-assemble the drawer's grouped action object ONCE from the (individually
  // memoized) handlers, instead of a fresh literal per render. Every dependency is
  // stable across a stream flush: the handlers turn over only when a real input
  // changes (a parked prompt resolving, the toast list, or the action-guard's
  // pending set transitioning) — never on a per-frame `nc:session` delta. This
  // holds ONLY because `useActionGuard` returns a memoized `action`; the guarded
  // handlers all list `action` in their deps, so an unmemoized `action` would
  // re-identify them (and this object) every render and defeat the memo. With that
  // invariant intact, the memoized TaskDetailChrome bails on a flush. (The `lifecycle`
  // / `workflow` container objects re-identify each render, so the memo lists the
  // individual handlers as deps — never those objects.)
  const closeDetail = useCallback(() => setSelectedId(null), [setSelectedId]);
  const detailActions = useMemo<TaskDetailActions>(
    () => ({
      onSelect: setSelectedId,
      onRun: lifecycle.handleRun,
      onCancel: lifecycle.handleCancel,
      onDelete: confirm.requestDelete,
      onRespondPermission: permissions.respond,
      onAnswerQuestion: questions.answer,
      onApprove: workflow.handleApprove,
      onReject: workflow.handleReject,
      onRefine: workflow.handleRefine,
      onChangeKind: lifecycle.handleChangeKind,
      onChangeRunMode: lifecycle.handleChangeRunMode,
      onChangePermissionMode: lifecycle.handleChangePermissionMode,
      onChangeModel: lifecycle.handleChangeModel,
      onChangeProvider: lifecycle.handleChangeProvider,
      onChangeEffort: lifecycle.handleChangeEffort,
      onChangeMaxTurns: lifecycle.handleChangeMaxTurns,
      onChangeMaxBudget: lifecycle.handleChangeMaxBudget,
      onAcceptReview: workflow.handleAcceptReview,
      onRejectReview: workflow.handleRejectReview,
      onRerunVerification: workflow.handleRerunVerification,
      onRunGauntlet: gauntlet.run,
      onConvertSubtask: workflow.handleConvertSubtask,
      onConvertAllSubtasks: workflow.handleConvertAllSubtasks,
      onMerge: workflow.handleMerge,
      onCommit: workflow.handleCommit,
      onCreatePr: createPr.openPrDialog,
      onOpenPr: createPr.openPr,
      onPushPrUpdates: prLifecycle.pushUpdates,
      onFinalizePr: prLifecycle.finalize,
      onPullBaseFf: prLifecycle.pullBase,
      onAddressPrComments: prLifecycle.addressComments,
      onResumeSession: lifecycle.handleResumeSession,
      onRenameSession: lifecycle.handleRenameSession,
      onTagSession: lifecycle.handleTagSession,
      onOpenTerminal,
      // Re-identifies only when the guard's pending set transitions — the same
      // cadence the guarded handlers above already turn over on, so including it
      // here adds no extra churn to this object's identity.
      isActionPending: action.isPending,
    }),
    [
      setSelectedId,
      lifecycle.handleRun,
      lifecycle.handleCancel,
      confirm.requestDelete,
      permissions.respond,
      questions.answer,
      workflow.handleApprove,
      workflow.handleReject,
      workflow.handleRefine,
      lifecycle.handleChangeKind,
      lifecycle.handleChangeRunMode,
      lifecycle.handleChangePermissionMode,
      lifecycle.handleChangeModel,
      lifecycle.handleChangeProvider,
      lifecycle.handleChangeEffort,
      lifecycle.handleChangeMaxTurns,
      lifecycle.handleChangeMaxBudget,
      workflow.handleAcceptReview,
      workflow.handleRejectReview,
      workflow.handleRerunVerification,
      gauntlet.run,
      workflow.handleConvertSubtask,
      workflow.handleConvertAllSubtasks,
      workflow.handleMerge,
      workflow.handleCommit,
      createPr.openPrDialog,
      createPr.openPr,
      prLifecycle.pushUpdates,
      prLifecycle.finalize,
      prLifecycle.pullBase,
      prLifecycle.addressComments,
      lifecycle.handleResumeSession,
      lifecycle.handleRenameSession,
      lifecycle.handleTagSession,
      onOpenTerminal,
      action.isPending,
    ],
  );

  return {
    detailActions,
    confirm,
    closeDetail,
    handleCreate: lifecycle.handleCreate,
    handleMoveTask: lifecycle.handleMoveTask,
  };
}
