/** DiffViewDialog helpers: the per-status pill presentation + the per-file patch
 *  expand/lazy-fetch hook. */
import { useCallback, useEffect, useState } from 'react';

import type { DiffStatus } from '@/lib/bridge';
import { worktreeFileDiff } from '@/lib/bridge';

/** Presentation for a diff status pill: the one-letter glyph, an accessible
 *  label (surfaced via `title`), and the tint classes. */
export interface DiffStatusMeta {
  /** Single-letter glyph shown in the pill (A/M/D/R/U). */
  letter: string;
  /** Human label for the status, used as the pill's `title`. */
  label: string;
  /** Tailwind tint classes (background + text) for the pill. */
  pill: string;
}

const STATUS_META: Record<DiffStatus, DiffStatusMeta> = {
  added: { letter: 'A', label: 'Added', pill: 'bg-emerald-500/15 text-emerald-400' },
  modified: { letter: 'M', label: 'Modified', pill: 'bg-sky-500/15 text-sky-400' },
  deleted: { letter: 'D', label: 'Deleted', pill: 'bg-red-500/15 text-red-400' },
  renamed: { letter: 'R', label: 'Renamed', pill: 'bg-amber-500/15 text-amber-400' },
  untracked: { letter: 'U', label: 'Untracked', pill: 'bg-white/[0.06] text-muted-foreground' },
};

/** The pill presentation for a diff status: emerald for added, sky for modified,
 *  red for deleted, amber for renamed, muted for untracked. */
export function diffStatusMeta(status: DiffStatus): DiffStatusMeta {
  return STATUS_META[status];
}

/** The per-file patch expansion state the file list binds to: which row is open,
 *  its fetched patch text (`null` until it resolves), the in-flight flag, and the
 *  toggle that opens a row / collapses the open one. */
export interface FilePatchState {
  /** The path of the currently-expanded row, or `null` when all are collapsed. */
  expandedPath: string | null;
  /** The expanded row's raw unified-diff patch, `null` before it resolves. */
  patch: string | null;
  /** True while the expanded row's patch is being fetched. */
  loading: boolean;
  /** Open `path`, or collapse it when it is already the open row. */
  toggle: (path: string) => void;
}

/** Manage the file list's inline per-file patch: track which row is expanded and
 *  lazily fetch that file's unified diff (`worktree_file_diff`). Clicking the open
 *  row collapses it; opening a different row re-fetches. A stale-resolve guard
 *  (via effect cleanup, mirroring the WorktreeView fetch discipline) drops a late
 *  response after the selection moved on, so a slow fetch never overwrites a newer
 *  row's patch. Idle when `taskId` is `null`. */
export function useFilePatch(taskId: string | null): FilePatchState {
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Collapse the open row whenever the dialog switches to a different task's diff,
  // so a path from the previous worktree never fetches against the new one.
  useEffect(() => {
    setExpandedPath(null);
  }, [taskId]);

  const toggle = useCallback((path: string) => {
    setExpandedPath((current) => (current === path ? null : path));
  }, []);

  useEffect(() => {
    if (taskId === null || expandedPath === null) {
      setPatch(null);
      setLoading(false);
      return;
    }
    setPatch(null);
    setLoading(true);
    let stale = false;
    void worktreeFileDiff(taskId, expandedPath)
      .then((text) => {
        if (stale) return;
        setPatch(text);
        setLoading(false);
      })
      .catch(() => {
        if (stale) return;
        // Degrade a failed fetch to the empty-patch note rather than a hard error —
        // the file list stays usable and the row simply shows nothing to display.
        setPatch('');
        setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [taskId, expandedPath]);

  return { expandedPath, patch, loading, toggle };
}
