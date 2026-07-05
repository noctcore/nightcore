import { useCallback, useEffect, useRef, useState } from 'react';

import { EMPTY_TRANSCRIPT, foldTranscript, type TaskTranscript } from '@/components/board';
import type { ToastApi } from '@/components/ui';
import type { SessionEnvelope, Task } from '@/lib/bridge';
import { listTasks, onProjectEvent, onSessionEvent, onTaskEvent, readTranscript } from '@/lib/bridge';

/** Terminal session events — when one arrives we flush the coalescing buffer
 *  immediately so the final tokens render promptly (not on the next rAF, which a
 *  backgrounded tab may throttle). */
const TERMINAL_EVENTS: ReadonlySet<string> = new Set(['session-completed', 'session-failed']);

/** The board's task + stream state, reseeded whenever a project is activated.
 *
 *  Stream coalescing (perf): `nc:session` fires per engine event, including
 *  token-level `assistant-delta` partials. Applying `setStreams` synchronously on
 *  every one re-renders AppShell→Board→TaskDetail per token. Instead we buffer
 *  incoming events in a ref and flush them in a single `setStreams` on the next
 *  animation frame — collapsing a burst of deltas into one render. The folded
 *  output is identical to folding each event individually. Terminal events
 *  (`session-completed`/`session-failed`) and unmount force an immediate flush so
 *  the last tokens never render late or get dropped. */
export function useBoard(toast: ToastApi) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [streams, setStreams] = useState<Record<string, TaskTranscript>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Seed from the active project's store, and reseed on every activation. A
  // monotonic generation drops out-of-order responses: switching project A→B fires
  // two `listTasks()` calls, and if A's resolves last it would otherwise show A's
  // tasks under B. Only the newest reseed (and a still-mounted view) may apply.
  // Lifted to a stable callback (not effect-local) so the explicit board Refresh
  // can re-pull tasks on demand through the same guard.
  const reseedGen = useRef(0);
  const aliveRef = useRef(true);
  const reseed = useCallback(() => {
    const myGen = ++reseedGen.current;
    void listTasks()
      .then((seed) => {
        if (aliveRef.current && myGen === reseedGen.current) setTasks(seed);
      })
      .catch((err) => {
        if (!aliveRef.current || myGen !== reseedGen.current) return;
        console.error('list_tasks failed', err);
        toast.error('Could not load tasks', err);
      });
  }, [toast]);
  useEffect(() => {
    aliveRef.current = true;
    reseed();
    const unlisten = onProjectEvent(({ type }) => {
      if (type === 'activated' || type === 'deleted') {
        setStreams({});
        setSelectedId(null);
        reseed();
      }
    });
    return () => {
      aliveRef.current = false;
      void unlisten.then((fn) => fn());
    };
  }, [reseed]);

  useEffect(() => {
    const unlisten = onTaskEvent((task) => {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === task.id);
        if (idx === -1) return [...prev, task];
        // Reconcile by `seq` (a strictly-monotonic per-store stamp): a `nc:task`
        // echo whose seq is not GREATER than the record we already hold is a
        // stale/out-of-order event (e.g. an optimistic move racing a run's
        // stream) — drop it so newer state isn't clobbered. This is a true
        // happens-before guard, unlike the collision-prone millisecond timestamp.
        const current = prev[idx];
        if (current !== undefined && task.seq <= current.seq) return prev;
        const next = prev.slice();
        next[idx] = task;
        return next;
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Coalesce `nc:session` deltas: buffer events and flush them in one `setStreams`
  // on the next animation frame. The buffer is drained in arrival order so the
  // fold is identical to applying each event live.
  const buffer = useRef<SessionEnvelope[]>([]);
  const frame = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    const pending = buffer.current;
    if (pending.length === 0) return;
    buffer.current = [];
    setStreams((prev) => {
      const next: Record<string, TaskTranscript> = { ...prev };
      for (const { taskId, event } of pending) {
        next[taskId] = foldTranscript(next[taskId] ?? EMPTY_TRANSCRIPT, event);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const unlisten = onSessionEvent((envelope) => {
      buffer.current.push(envelope);
      if (TERMINAL_EVENTS.has(envelope.event.type)) {
        // Terminal: render the final transcript immediately rather than waiting on
        // a possibly-throttled animation frame.
        flush();
        return;
      }
      if (frame.current === null) {
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          flush();
        });
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
      // Flush any buffered events on teardown so the last tokens aren't dropped,
      // then cancel a pending frame.
      flush();
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    };
  }, [flush]);

  // Reseed the opened task's transcript from its persisted JSONL so a
  // reload/HMR no longer blanks it. Skips a task that already has a live stream
  // (an in-flight run's accumulating events must not be clobbered).
  useEffect(() => {
    if (selectedId === null) return;
    let alive = true;
    const id = selectedId;
    void readTranscript(id)
      .then((events) => {
        if (!alive || events.length === 0) return;
        setStreams((prev) => {
          if (prev[id] !== undefined) return prev;
          const seeded = events.reduce(foldTranscript, { ...EMPTY_TRANSCRIPT });
          return { ...prev, [id]: seeded };
        });
      })
      .catch((err) => {
        // A missing/unreadable transcript is non-fatal — the panel just shows the
        // empty timeline — but surface it so the open task isn't silently blank.
        console.error('read_transcript failed', err);
        toast.error('Could not load this task’s transcript', err);
      });
    return () => {
      alive = false;
    };
  }, [selectedId, toast]);

  return { tasks, setTasks, streams, setStreams, selectedId, setSelectedId, reseed };
}
