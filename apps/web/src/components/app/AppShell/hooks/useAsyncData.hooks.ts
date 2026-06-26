import { useEffect } from 'react';

/** Subscribe to a load with a "still mounted" guard. Folds the hand-rolled
 *  `let alive = true` mount-loads into one place; `load` runs once on mount and
 *  `onResult` only fires while mounted, so a late resolve can't set state on an
 *  unmounted component. */
export function useAsyncData<T>(load: () => Promise<T>, onResult: (value: T) => void): void {
  // `load`/`onResult` are expected stable (defined at hook scope); we intentionally
  // run once on mount, mirroring the previous inline effects.
  useEffect(() => {
    let alive = true;
    void load()
      .then((value) => {
        if (alive) onResult(value);
      })
      .catch((err) => {
        // Defense-in-depth: today's callers pass a `load` that routes its own
        // failure to a toast, but a future caller that forgets — or an `onResult`
        // that throws — must not escape as an unhandled promise rejection. Log so
        // the failure stays diagnosable (the global 'unhandledrejection' net is a
        // backstop, not the first responder).
        console.error('useAsyncData load failed', err);
      });
    return () => {
      alive = false;
    };
  }, []);
}
