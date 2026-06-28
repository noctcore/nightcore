import { useCallback, useState } from 'react';

/** The in-flight-action tracker returned by {@link useActionGuard}. */
export interface ActionGuard {
  /** Run a guarded action: no-op if already in flight; clears the key when the
   *  underlying command settles. Returns immediately for callers that don't await. */
  guard: (action: string, id: string, run: () => Promise<unknown>) => void;
  isPending: (action: string, id: string) => boolean;
}

/** Tracks in-flight task actions keyed by `${action}:${id}` so an action button
 *  can disable between click and the command settling — closing the double-fire
 *  window the audit flagged on Run/Approve/Refine/Reject/Commit/Merge. */
export function useActionGuard(): ActionGuard {
  const [pending, setPending] = useState<Set<string>>(new Set());

  const mark = useCallback((key: string, on: boolean) => {
    setPending((prev) => {
      if (on === prev.has(key)) return prev;
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const guard = useCallback(
    (action: string, id: string, run: () => Promise<unknown>): void => {
      const key = `${action}:${id}`;
      let already = false;
      setPending((prev) => {
        if (prev.has(key)) {
          already = true;
          return prev;
        }
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      if (already) return;
      void run().finally(() => mark(key, false));
    },
    [mark],
  );

  const isPending = useCallback(
    (action: string, id: string) => pending.has(`${action}:${id}`),
    [pending],
  );

  return { guard, isPending };
}
