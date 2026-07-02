/** Orchestration for the worktree manager surface: dialog state, on-demand
 *  merge-preview / diff fetches, and the merge / discard bridge actions with
 *  friendly error toasts. The view component stays a thin shell over this. */
import { useCallback, useState } from 'react';

import { useToast } from '@/components/ui';
import type { MergePreview, Task, WorktreeDiff, WorktreeInfo } from '@/lib/bridge';
import { discardWorktree, mergePreview, mergeTask, worktreeDiff } from '@/lib/bridge';
import { parseGitError } from '@/lib/git-error';

/** The merge-preview dialog's data, keyed by the task it was opened for. */
interface PreviewState {
  taskId: string;
  data: MergePreview | null;
  loading: boolean;
}

/** The diff dialog's data, keyed by the task it was opened for. */
interface DiffState {
  taskId: string;
  data: WorktreeDiff | null;
  loading: boolean;
}

/** The discard dialog's state (and in-flight / error tracking). */
interface DiscardState {
  taskId: string;
  branch: string;
  changedFiles: number;
  discarding: boolean;
  error: string | null;
}

/** The view-model the WorktreeView binds to. */
export interface WorktreeViewModel {
  titleForTask: (id: string) => string | undefined;
  openDiff: (taskId: string) => void;
  openPreview: (taskId: string) => void;
  openDiscard: (taskId: string) => void;
  preview: PreviewState | null;
  merging: boolean;
  confirmMerge: () => void;
  closePreview: () => void;
  onPreviewViewDiff: () => void;
  diff: DiffState | null;
  closeDiff: () => void;
  discard: DiscardState | null;
  confirmDiscard: () => void;
  closeDiscard: () => void;
}

export function useWorktreeView(tasks: Task[], worktrees: WorktreeInfo[]): WorktreeViewModel {
  const toast = useToast();
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [merging, setMerging] = useState(false);
  const [diff, setDiff] = useState<DiffState | null>(null);
  const [discard, setDiscard] = useState<DiscardState | null>(null);

  const titleForTask = useCallback(
    (id: string) => tasks.find((t) => t.id === id)?.title,
    [tasks],
  );

  const reportError = useCallback(
    (err: unknown) => {
      const { title, detail } = parseGitError(err);
      toast.error(title, detail);
    },
    [toast],
  );

  const openPreview = useCallback(
    (taskId: string) => {
      setPreview({ taskId, data: null, loading: true });
      void mergePreview(taskId)
        .then((data) =>
          // Ignore a stale resolve if the dialog moved on to another task.
          setPreview((p) => (p && p.taskId === taskId ? { ...p, data, loading: false } : p)),
        )
        .catch((err) => {
          reportError(err);
          // Only close if this request is still the open one — a late rejection of a
          // dismissed request must not close a newer preview.
          setPreview((p) => (p && p.taskId === taskId ? null : p));
        });
    },
    [reportError],
  );

  const openDiff = useCallback(
    (taskId: string) => {
      setDiff({ taskId, data: null, loading: true });
      void worktreeDiff(taskId)
        .then((data) =>
          setDiff((d) => (d && d.taskId === taskId ? { ...d, data, loading: false } : d)),
        )
        .catch((err) => {
          reportError(err);
          setDiff((d) => (d && d.taskId === taskId ? null : d));
        });
    },
    [reportError],
  );

  const openDiscard = useCallback(
    (taskId: string) => {
      const wt = worktrees.find((w) => w.taskIds.includes(taskId));
      const branch = wt?.branch ?? tasks.find((t) => t.id === taskId)?.branch ?? '';
      setDiscard({
        taskId,
        branch,
        changedFiles: wt?.changedFiles ?? 0,
        discarding: false,
        error: null,
      });
    },
    [tasks, worktrees],
  );

  const confirmMerge = useCallback(() => {
    if (preview === null) return;
    const { taskId } = preview;
    setMerging(true);
    void mergeTask(taskId)
      .then(() => {
        toast.push({ tone: 'success', title: 'Branch merged into base' });
        setPreview(null);
      })
      .catch(reportError)
      .finally(() => setMerging(false));
  }, [preview, reportError, toast]);

  const confirmDiscard = useCallback(() => {
    if (discard === null) return;
    const { taskId } = discard;
    setDiscard((d) => (d ? { ...d, discarding: true, error: null } : d));
    void discardWorktree(taskId)
      .then(() => {
        toast.push({ tone: 'success', title: 'Worktree discarded' });
        setDiscard(null);
      })
      .catch((err) => {
        // Keep the dialog open and surface the error inline (drives the retry state),
        // but only if this discard is still the open one (guard a cancel-then-reopen).
        const { detail } = parseGitError(err);
        setDiscard((d) =>
          d && d.taskId === taskId ? { ...d, discarding: false, error: detail } : d,
        );
      });
  }, [discard, toast]);

  const onPreviewViewDiff = useCallback(() => {
    if (preview === null) return;
    // Close the preview before opening the diff — the Modal primitive is not built
    // to stack (two focus traps + Esc listeners would fight), so the dialogs must be
    // mutually exclusive.
    const { taskId } = preview;
    setPreview(null);
    openDiff(taskId);
  }, [preview, openDiff]);

  const closePreview = useCallback(() => setPreview(null), []);
  const closeDiff = useCallback(() => setDiff(null), []);
  const closeDiscard = useCallback(() => setDiscard(null), []);

  return {
    titleForTask,
    openDiff,
    openPreview,
    openDiscard,
    preview,
    merging,
    confirmMerge,
    closePreview,
    onPreviewViewDiff,
    diff,
    closeDiff,
    discard,
    confirmDiscard,
    closeDiscard,
  };
}
