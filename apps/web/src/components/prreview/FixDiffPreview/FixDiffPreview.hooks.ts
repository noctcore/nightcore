/** FixDiffPreview data hook: fetch the fix commit's changed-file list once, then
 *  lazily fetch each file's unified-diff patch on expand. Mirrors the worktree
 *  `useFilePatch` stale-resolve discipline so a slow fetch never overwrites a
 *  newer selection. */
import { useCallback, useEffect, useState } from 'react';

import type { DiffStatus, WorktreeDiff, WorktreeDiffFile } from '@/lib/bridge';

/** Single-letter glyph per diff status for the compact file row (A/M/D/R/U). */
export const STATUS_LETTER: Record<DiffStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

/** The state the FixDiffPreview view binds to. */
export interface FixDiffState {
  /** True while the changed-file list is being fetched. */
  loading: boolean;
  /** A fetch failure message, or `null`. */
  error: string | null;
  /** The git summary line (`N files changed, +a -d`), or `''` when empty. */
  summary: string;
  /** The changed files of the fix commit. */
  files: WorktreeDiffFile[];
  /** The expanded row's path, or `null` when all are collapsed. */
  expandedPath: string | null;
  /** The expanded row's unified-diff patch, `null` until it resolves. */
  patch: string | null;
  /** True while the expanded row's patch is being fetched. */
  patchLoading: boolean;
  /** Open `path`, or collapse it when it is already open. */
  toggle: (path: string) => void;
  /** Re-run the changed-file-list fetch (the error-state Retry affordance). */
  retry: () => void;
}

/** Own the fix-diff fetch + the per-file expand. The fetchers are injected (the
 *  component defaults them to the real bridge commands) so stories/tests drive a
 *  populated diff without a Tauri backend. */
export function useFixDiff(
  fixId: string,
  fetchDiff: (fixId: string) => Promise<WorktreeDiff>,
  fetchPatch: (fixId: string, path: string) => Promise<string>,
): FixDiffState {
  const [diff, setDiff] = useState<WorktreeDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [patchLoading, setPatchLoading] = useState(false);
  // Bumping the epoch re-runs the list fetch (the error-state Retry).
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    setExpandedPath(null);
    fetchDiff(fixId).then(
      (d) => {
        if (stale) return;
        setDiff(d);
        setLoading(false);
      },
      (e) => {
        if (stale) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
    return () => {
      stale = true;
    };
  }, [fixId, fetchDiff, epoch]);

  const toggle = useCallback((path: string) => {
    setExpandedPath((current) => (current === path ? null : path));
  }, []);

  const retry = useCallback(() => setEpoch((n) => n + 1), []);

  useEffect(() => {
    if (expandedPath === null) {
      setPatch(null);
      setPatchLoading(false);
      return;
    }
    setPatch(null);
    setPatchLoading(true);
    let stale = false;
    fetchPatch(fixId, expandedPath).then(
      (text) => {
        if (stale) return;
        setPatch(text);
        setPatchLoading(false);
      },
      () => {
        if (stale) return;
        // Degrade a failed patch fetch to the empty note — the row stays usable.
        setPatch('');
        setPatchLoading(false);
      },
    );
    return () => {
      stale = true;
    };
  }, [fixId, expandedPath, fetchPatch]);

  return {
    loading,
    error,
    summary: diff?.summary ?? '',
    files: diff?.files ?? [],
    expandedPath,
    patch,
    patchLoading,
    toggle,
    retry,
  };
}
