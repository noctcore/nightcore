/** Orchestration for the worktree manager surface: dialog state, on-demand
 *  merge-preview / diff fetches, and the merge / discard bridge actions with
 *  friendly error toasts. The view component stays a thin shell over this. */
import { useCallback, useState } from 'react';

import { useToast } from '@/components/ui';
import type { MergePreview, Task, WorktreeDiff, WorktreeInfo } from '@/lib/bridge';
import {
  discardWorktree,
  killTerminal,
  mergePreview,
  mergeTask,
  openExternal,
  openInEditor,
  revealWorktree,
  terminalSessionsInDir,
  worktreeDiff,
} from '@/lib/bridge';
import { parseGitError } from '@/lib/git-error';

import type { WorktreePrRef } from '../WorktreeManager';

/** The merge-preview dialog's data, keyed by the task it was opened for. */
interface PreviewState {
  taskId: string;
  data: MergePreview | null;
  loading: boolean;
  /** Live terminal session ids open in this worktree (terminal spec, decision 2):
   *  the merge notice's count + the sessions the confirm kills before merging. */
  terminalSessions: string[];
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
  /** Live terminal session ids open in this worktree (terminal spec, decision 2). */
  terminalSessions: string[];
}

/** The view-model the WorktreeView binds to. */
export interface WorktreeViewModel {
  titleForTask: (id: string) => string | undefined;
  /** The PR recorded on a task (`prUrl`/`prNumber`), for the row's passive
   *  `PR #n` chip — threaded like `titleForTask`; `null` when the task has
   *  none. Static resolution only (no per-row status fetching). */
  prForTask: (id: string) => WorktreePrRef | null;
  /** Open a PR page in the system browser (https-gated Rust-side). */
  openPr: (url: string) => void;
  /** Reveal a worktree's directory in Finder (path resolved server-side). */
  reveal: (taskId: string) => void;
  /** Open a worktree's directory in the user's editor (path resolved server-side). */
  openEditor: (taskId: string) => void;
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

  const prForTask = useCallback(
    (id: string): WorktreePrRef | null => {
      const task = tasks.find((t) => t.id === id);
      if (task?.prUrl === undefined) return null;
      return { url: task.prUrl, number: task.prNumber ?? null };
    },
    [tasks],
  );

  const openPr = useCallback(
    (url: string) => {
      // The bridge command is https-only Rust-side; failures surface as a toast
      // (the useCreatePr openPr discipline).
      void openExternal(url).catch((err: unknown) => {
        console.error('open_external failed', err);
        toast.error('Could not open the pull request', err);
      });
    },
    [toast],
  );

  const reveal = useCallback(
    (taskId: string) => {
      // Path is resolved + confined server-side; a failure (worktree discarded, no
      // Finder) surfaces as a toast, mirroring the openPr discipline.
      void revealWorktree(taskId).catch((err: unknown) => {
        console.error('reveal_worktree failed', err);
        toast.error('Could not reveal the worktree', err);
      });
    },
    [toast],
  );

  const openEditor = useCallback(
    (taskId: string) => {
      // Rust picks the Settings-pinned editor (else auto-detects); a "no editor
      // found" error surfaces here so the user knows to pick one in Settings.
      void openInEditor(taskId).catch((err: unknown) => {
        console.error('open_in_editor failed', err);
        toast.error('Could not open the editor', err);
      });
    },
    [toast],
  );

  const reportError = useCallback(
    (err: unknown) => {
      const { title, detail } = parseGitError(err);
      toast.error(title, detail);
    },
    [toast],
  );

  // Live terminal sessions open in a task's worktree dir (terminal spec, decision
  // 2). Tolerant: an error (or no Tauri) reads as "none open", so the merge/discard
  // flows never block on a fetch failure.
  const fetchWorktreeSessions = useCallback(
    async (taskId: string): Promise<string[]> => {
      const wt = worktrees.find((w) => w.taskIds.includes(taskId));
      if (wt === undefined) return [];
      try {
        const sessions = await terminalSessionsInDir(wt.path);
        return sessions.map((s) => s.id);
      } catch {
        return [];
      }
    },
    [worktrees],
  );

  const openPreview = useCallback(
    (taskId: string) => {
      setPreview({ taskId, data: null, loading: true, terminalSessions: [] });
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
      void fetchWorktreeSessions(taskId).then((ids) =>
        setPreview((p) => (p && p.taskId === taskId ? { ...p, terminalSessions: ids } : p)),
      );
    },
    [reportError, fetchWorktreeSessions],
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
        terminalSessions: [],
      });
      void fetchWorktreeSessions(taskId).then((ids) =>
        setDiscard((d) => (d && d.taskId === taskId ? { ...d, terminalSessions: ids } : d)),
      );
    },
    [tasks, worktrees, fetchWorktreeSessions],
  );

  const confirmMerge = useCallback(() => {
    if (preview === null) return;
    const { taskId, terminalSessions } = preview;
    setMerging(true);
    // Decision 2: close any live terminal sessions in this worktree BEFORE merging
    // (best-effort — a shell in a soon-cleaned dir is harmless), then merge.
    void Promise.allSettled(terminalSessions.map((id) => killTerminal(id)))
      .then(() => mergeTask(taskId))
      .then(() => {
        toast.push({ tone: 'success', title: 'Branch merged into base' });
        setPreview(null);
      })
      .catch(reportError)
      .finally(() => setMerging(false));
  }, [preview, reportError, toast]);

  const confirmDiscard = useCallback(() => {
    if (discard === null) return;
    const { taskId, terminalSessions } = discard;
    setDiscard((d) => (d ? { ...d, discarding: true, error: null } : d));
    // Decision 2: close any live terminal sessions in this worktree first (best-
    // effort), then discard.
    void Promise.allSettled(terminalSessions.map((id) => killTerminal(id)))
      .then(() => discardWorktree(taskId))
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
    prForTask,
    openPr,
    reveal,
    openEditor,
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
