import { useCallback, useEffect, useRef, useState } from 'react';

import { blockedTaskIds, onTaskEvent } from '@/lib/bridge';

import { useDebouncedRefetch } from './useDebouncedRefetch.hooks';

/** The backend-computed blocked-task set (deps not yet satisfied, fail-closed).
 *  Fetched on mount and refreshed (trailing-debounced) on `nc:task` — dependency
 *  satisfaction changes as tasks complete, so a card unblocks the moment its last
 *  dep lands. A burst of task events collapses to one refetch. */
export function useBlockedIds(): Set<string> {
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());

  // Monotonic request id: every refetch stamps a request, so an older,
  // slower response can't clobber a newer one. Refs so the fetch closure stays
  // stable across renders (the debounce reads the latest).
  const alive = useRef(true);
  const seq = useRef(0);
  const applied = useRef(0);

  const fetchNow = useCallback(() => {
    const id = ++seq.current;
    void blockedTaskIds()
      .then((ids) => {
        if (!alive.current || id < applied.current) return;
        applied.current = id;
        setBlockedIds(new Set(ids));
      })
      .catch((err) => console.error('blocked_task_ids failed', err));
  }, []);

  const refresh = useDebouncedRefetch(fetchNow);

  useEffect(() => {
    alive.current = true;
    // First load is immediate (not debounced) so the board paints with the real
    // blocked set straight away; subsequent `nc:task` bursts are debounced.
    fetchNow();
    const unlisten = onTaskEvent(() => refresh());
    return () => {
      alive.current = false;
      void unlisten.then((fn) => fn());
    };
  }, [fetchNow, refresh]);

  return blockedIds;
}
