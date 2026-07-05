import { useCallback, useEffect, useRef, useState } from 'react';

import type { ActiveWorktree } from '@/components/board';
import {
  listWorktrees,
  onProjectEvent,
  onTaskEvent,
  refreshWorktrees,
  type WorktreeInfo,
} from '@/lib/bridge';

import { useDebouncedRefetch } from './useDebouncedRefetch.hooks';

/** The active project's live worktrees plus the selected worktree tab.
 *  Worktrees are fetched on mount, refreshed (trailing-debounced) on `nc:task`
 *  (a run can allocate/dirty a worktree — and a refetch spawns git subprocesses,
 *  so a burst collapses to one), and refreshed immediately on project activation;
 *  the active selection resets to Main (`null`) whenever the project changes.
 *  `reconcile` is the explicit user "Refresh": it runs the server-side reconcile
 *  (prune orphans, clear ghost pointers, reclaim merged worktrees) and applies the
 *  returned statuses — recovering from stale state without an app restart. */
export function useWorktrees(): {
  worktrees: WorktreeInfo[];
  active: ActiveWorktree;
  setActive: (active: ActiveWorktree) => void;
  reconcile: () => Promise<void>;
} {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [active, setActive] = useState<ActiveWorktree>(null);

  // Monotonic request id: like useBlockedIds, drop a stale response that
  // resolves after a newer refetch so the switcher never shows older data.
  const alive = useRef(true);
  const seq = useRef(0);
  const applied = useRef(0);

  // Apply a worktree list under the monotonic-seq guard so a slow response can't
  // clobber a newer one. Returns whether it was applied (newest + still mounted).
  const applyList = useCallback((id: number, list: WorktreeInfo[]): boolean => {
    if (!alive.current || id < applied.current) return false;
    applied.current = id;
    setWorktrees(list);
    return true;
  }, []);

  const fetchNow = useCallback(() => {
    const id = ++seq.current;
    void listWorktrees()
      .then((list) => applyList(id, list))
      .catch((err) => console.error('list_worktrees failed', err));
  }, [applyList]);

  // The explicit refresh: reconcile server-side, then apply the fresh statuses
  // through the same seq guard. Rejections propagate so the caller can toast.
  const reconcile = useCallback(async () => {
    const id = ++seq.current;
    const list = await refreshWorktrees();
    applyList(id, list);
  }, [applyList]);

  const refresh = useDebouncedRefetch(fetchNow);

  useEffect(() => {
    alive.current = true;
    fetchNow();
    const unlistenTask = onTaskEvent(() => refresh());
    const unlistenProject = onProjectEvent(({ type }) => {
      if (type === 'activated' || type === 'deleted') {
        // Project switches reset to Main and refetch immediately — the user just
        // changed context, so don't make them wait out the task-burst debounce.
        setActive(null);
        fetchNow();
      }
    });
    return () => {
      alive.current = false;
      void unlistenTask.then((fn) => fn());
      void unlistenProject.then((fn) => fn());
    };
  }, [fetchNow, refresh]);

  return { worktrees, active, setActive, reconcile };
}
