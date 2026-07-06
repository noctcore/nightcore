import { useCallback } from 'react';

import type { ToastApi } from '@/components/ui';
import {
  acceptReview,
  approveTask,
  commitTask,
  convertAllSubtasks,
  convertSubtask,
  mergeTask,
  refineTask,
  rejectReview,
  rejectTask,
  rerunVerification,
} from '@/lib/bridge';

import type { ActionGuard } from './useActionGuard.hooks';

/** The single-flight guard + failure channel the workflow-gate handlers close over.
 *  Unlike the lifecycle actions these touch no board state — the authoritative status
 *  always arrives via `nc:task`. */
export interface TaskWorkflowDeps {
  action: ActionGuard;
  toast: ToastApi;
}

/** The board's guarded workflow-GATE actions: plan approval (approve/reject/refine),
 *  the commit/merge git ops, the review verdict handlers (accept/reject/rerun), and
 *  the convert-subtask gates. Each resolves a parked request or runs a store/git op
 *  on the backend and settles via the `nc:task` echo — none holds board state, so
 *  this layer stays apart from the optimistic `useTaskLifecycleActions`. All are
 *  single-flighted against a double-fire and surface failures through the toast
 *  channel; commit/merge/convert ALSO toast on success because — unlike
 *  approve/reject/refine, which visibly move the card to a new column — their result
 *  leaves no board signal, so the toast is the only confirmation the click landed
 *  (the PR-lifecycle + WorktreeView `tone: 'success'` convention). */
export function useTaskWorkflowActions({ action, toast }: TaskWorkflowDeps) {
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

  return {
    handleApprove,
    handleReject,
    handleRefine,
    handleCommit,
    handleMerge,
    handleAcceptReview,
    handleRejectReview,
    handleRerunVerification,
    handleConvertSubtask,
    handleConvertAllSubtasks,
  };
}

/** The guarded workflow-gate action layer returned by
 *  {@link useTaskWorkflowActions}. */
export type TaskWorkflowActions = ReturnType<typeof useTaskWorkflowActions>;
