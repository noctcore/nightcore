import { useCallback, useEffect, useRef, useState } from 'react';

import type { ActiveWorktree } from '@/components/board';
import { listWorktrees, onProjectEvent, onTaskEvent, type WorktreeInfo } from '@/lib/bridge';

import { useDebouncedRefetch } from './useDebouncedRefetch.hooks';

/** The active project's live worktrees plus the selected worktree tab.
 *  Worktrees are fetched on mount, refreshed (trailing-debounced) on `nc:task`
 *  (a run can allocate/dirty a worktree — and a refetch spawns git subprocesses,
 *  so a burst collapses to one), and refreshed immediately on project activation;
 *  the active selection resets to Main (`null`) whenever the project changes. */
export function useWorktrees(): {
  worktrees: WorktreeInfo[];
  active: ActiveWorktree;
  setActive: (active: ActiveWorktree) => void;
} {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [active, setActive] = useState<ActiveWorktree>(null);

  // Monotonic request id: like useBlockedIds, drop a stale response that
  // resolves after a newer refetch so the switcher never shows older data.
  const alive = useRef(true);
  const seq = useRef(0);
  const applied = useRef(0);

  const fetchNow = useCallback(() => {
    const id = ++seq.current;
    void listWorktrees()
      .then((list) => {
        if (!alive.current || id < applied.current) return;
        applied.current = id;
        setWorktrees(list);
      })
      .catch((err) => console.error('list_worktrees failed', err));
  }, []);

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

  return { worktrees, active, setActive };
}
