import { useCallback, useEffect, useState } from 'react';
import { onProjectEvent, runGauntlet, type GauntletResult } from '@/lib/bridge';
import type { ToastApi } from '@/components/ui';

/** Per-task readiness-gauntlet results + in-flight state. The Verified
 *  column runs the gauntlet on demand; the result gates the merge. Results are
 *  cleared whenever the project is re-activated (the board re-seeds). */
export function useGauntlet(toast: ToastApi) {
  const [results, setResults] = useState<Record<string, GauntletResult>>({});
  const [running, setRunning] = useState<Set<string>>(new Set());

  useEffect(() => {
    const unlisten = onProjectEvent(({ type }) => {
      if (type === 'activated' || type === 'deleted') {
        setResults({});
        setRunning(new Set());
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const run = useCallback(
    (id: string) => {
      setRunning((prev) => new Set(prev).add(id));
      void runGauntlet(id)
        .then((result) => setResults((prev) => ({ ...prev, [id]: result })))
        .catch((err) => {
          console.error('run_gauntlet failed', err);
          toast.error('Could not run the readiness checks', err);
          // Surface a failed result so the merge gate stays closed and the user
          // sees the failure in the Verified column rather than a silent no-op.
          setResults((prev) => ({
            ...prev,
            [id]: {
              passed: false,
              steps: [],
              failedStep: 'Checks could not run',
            },
          }));
        })
        .finally(() =>
          setRunning((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          }),
        );
    },
    [toast],
  );

  return { results, running, run };
}
