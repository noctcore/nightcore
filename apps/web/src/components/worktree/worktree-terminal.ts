/**
 * Terminal-worktree orchestration for the Worktrees view (spec PR 5a/5c). Owns the list of
 * user-created terminal worktrees (the separate `term/` namespace) and their discard flow,
 * including the cleanup interlock: a discard fetches the live terminal sessions open in the
 * worktree dir, warns, and closes them before removing it. A feature-root hook module (the
 * `*-terminal.ts` pattern) so the WorktreeView shell stays thin and the task-worktree flow
 * (`useWorktreeView`) is left untouched.
 */
import { useCallback, useEffect, useState } from 'react';

import { useToast } from '@/components/ui';
import type { WorktreeInfo } from '@/lib/bridge';
import {
  discardTerminalWorktree,
  killTerminal,
  listTerminalWorktrees,
  terminalSessionsInDir,
} from '@/lib/bridge';
import { parseGitError } from '@/lib/git-error';
import { pathLeaf } from '@/lib/path-display';

/** The discard dialog's state for a terminal worktree (spec PR 5c). Keyed on the worktree
 *  `slug` (its dir name = the discard target) + `path` (the session-interlock query). */
interface TerminalDiscardState {
  slug: string;
  path: string;
  branch: string;
  changedFiles: number;
  discarding: boolean;
  error: string | null;
  /** Live terminal session ids open in this worktree — the interlock's count + kill list. */
  terminalSessions: string[];
}

/** The terminal-worktree list + discard flow the WorktreeView binds to. */
export function useTerminalWorktrees() {
  const toast = useToast();
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [discard, setDiscard] = useState<TerminalDiscardState | null>(null);

  const reload = useCallback(() => {
    void listTerminalWorktrees()
      .then(setWorktrees)
      .catch(() => setWorktrees([]));
  }, []);

  useEffect(() => reload(), [reload]);

  const openDiscard = useCallback((worktree: WorktreeInfo) => {
    // The dir name IS the slug (the discard target); the path drives the interlock query.
    const slug = pathLeaf(worktree.path);
    setDiscard({
      slug,
      path: worktree.path,
      branch: worktree.branch,
      changedFiles: worktree.changedFiles,
      discarding: false,
      error: null,
      terminalSessions: [],
    });
    // Fetch the live sessions open in the worktree dir (the cleanup interlock). Tolerant:
    // an error (or no Tauri) reads as "none open", so the flow never blocks on a failure.
    void terminalSessionsInDir(worktree.path)
      .then((sessions) => sessions.map((s) => s.id))
      .catch(() => [])
      .then((ids) =>
        setDiscard((d) => (d && d.slug === slug ? { ...d, terminalSessions: ids } : d)),
      );
  }, []);

  const confirmDiscard = useCallback(() => {
    if (discard === null) return;
    const { slug, terminalSessions } = discard;
    setDiscard((d) => (d ? { ...d, discarding: true, error: null } : d));
    // Close any live terminal sessions in this worktree first (best-effort), then discard.
    void Promise.allSettled(terminalSessions.map((id) => killTerminal(id)))
      .then(() => discardTerminalWorktree(slug))
      .then(() => {
        toast.push({ tone: 'success', title: 'Terminal worktree discarded' });
        setDiscard(null);
        reload();
      })
      .catch((err) => {
        const { detail } = parseGitError(err);
        setDiscard((d) => (d && d.slug === slug ? { ...d, discarding: false, error: detail } : d));
      });
  }, [discard, toast, reload]);

  const closeDiscard = useCallback(() => setDiscard(null), []);

  return { worktrees, reload, discard, openDiscard, confirmDiscard, closeDiscard };
}
