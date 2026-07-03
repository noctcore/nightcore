import { useCallback, useEffect, useMemo, useState } from 'react';

import type { BreakerInfo } from '@/components/board';
import type { ToastApi } from '@/components/ui';
import {
  type LoopEnvelope,
  onLoopEvent,
  resumeAutoLoop,
  setMaxConcurrency,
  startAutoLoop,
  stopAutoLoop,
} from '@/lib/bridge';

/** Live autonomous-loop state, derived from `nc:loop`. The board's Auto Mode
 *  toggle and concurrency slider reflect this; the persisted concurrency is the
 *  first-load fallback until the first loop event arrives. */
export function useAutoLoop(
  fallbackConcurrency: number,
  persistConcurrency: (n: number) => void,
  toast: ToastApi,
) {
  const [loop, setLoop] = useState<LoopEnvelope | null>(null);

  useEffect(() => {
    const unlisten = onLoopEvent(setLoop);
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const autoMode = loop?.state === 'running';
  const concurrency = loop?.maxConcurrency ?? fallbackConcurrency;
  const breaker = useMemo<BreakerInfo | null>(() => {
    if (loop?.state !== 'paused') return null;
    if (loop.reason === undefined || !loop.reason.toLowerCase().includes('circuit')) {
      return null;
    }
    return { failureThreshold: loop.failureThreshold };
  }, [loop]);

  const toggleAutoMode = useCallback(() => {
    const fn = loop?.state === 'running' ? stopAutoLoop : startAutoLoop;
    void fn().catch((err) => {
      console.error('auto loop toggle failed', err);
      toast.error('Could not toggle Auto Mode', err);
    });
  }, [loop, toast]);

  const changeConcurrency = useCallback(
    (n: number) => {
      void setMaxConcurrency(n)
        .then(() => {
          // Only persist the value the backend actually accepted; a rejected
          // command must not survive as the persisted first-load fallback.
          persistConcurrency(n);
        })
        .catch((err) => {
          console.error('set_max_concurrency failed', err);
          toast.error('Could not change concurrency', err);
        });
    },
    [persistConcurrency, toast],
  );

  const resume = useCallback(() => {
    void resumeAutoLoop().catch((err) => {
      console.error('resume_auto_loop failed', err);
      toast.error('Could not resume the loop', err);
    });
  }, [toast]);

  return { autoMode, concurrency, breaker, toggleAutoMode, changeConcurrency, resume };
}
