import { useCallback, useEffect, useRef, useState } from 'react';

import { EMPTY_RUN_ORDER } from '@/components/board';
import { onLoopEvent, onTaskEvent, runOrder,type RunOrderProjection } from '@/lib/bridge';

import { useDebouncedRefetch } from './useDebouncedRefetch.hooks';

/** The backend-computed run-order projection (#402): launchable tasks in the order the
 *  auto-loop will pick them up, plus the live slot context.
 *
 *  Fetched on mount and refreshed (trailing-debounced) on BOTH `nc:task` and `nc:loop` —
 *  the order shifts when a task's status/dependencies change AND when slot availability
 *  or the concurrency cap does (wave 0's capacity is `freeSlots`). A burst of events
 *  collapses to one refetch, so this never enters the per-frame `nc:session` cadence.
 *
 *  Mirrors {@link useBlockedIds}: the projection is derived from the FULL registry plus
 *  live run state, so it belongs to the backend — the web never re-derives the ordering
 *  (that drift is exactly what the id-based dependency chips replaced). */
export function useRunOrder(): RunOrderProjection {
  const [projection, setProjection] = useState<RunOrderProjection>(EMPTY_RUN_ORDER);

  // Monotonic request id: every refetch stamps a request, so an older, slower response
  // can't clobber a newer one. Refs so the fetch closure stays stable across renders.
  const alive = useRef(true);
  const seq = useRef(0);
  const applied = useRef(0);

  const fetchNow = useCallback(() => {
    const id = ++seq.current;
    void runOrder()
      .then((next) => {
        if (!alive.current || id < applied.current) return;
        applied.current = id;
        setProjection(next);
      })
      .catch((err) => console.error('run_order failed', err));
  }, []);

  const refresh = useDebouncedRefetch(fetchNow);

  useEffect(() => {
    alive.current = true;
    // First load is immediate (not debounced) so the board paints with the real order
    // straight away; subsequent event bursts are debounced.
    fetchNow();
    const unlistenTask = onTaskEvent(() => refresh());
    const unlistenLoop = onLoopEvent(() => refresh());
    return () => {
      alive.current = false;
      void unlistenTask.then((fn) => fn());
      void unlistenLoop.then((fn) => fn());
    };
  }, [fetchNow, refresh]);

  return projection;
}
