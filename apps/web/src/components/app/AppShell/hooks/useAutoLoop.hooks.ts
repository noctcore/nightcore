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

  // ARMED truth, not `state`: an armed loop that momentarily drains reports
  // `state: 'drained'` while still set to launch the next backlog task. Reading
  // `armed` keeps the toggle honest (ON while armed-but-idle) and, crucially, makes
  // its click a real disarm — the prior `state === 'running'` read showed OFF while
  // armed and its click re-armed (a no-op), leaving no way to stop the loop.
  const autoMode = loop?.armed ?? false;
  const concurrency = loop?.maxConcurrency ?? fallbackConcurrency;
  const breaker = useMemo<BreakerInfo | null>(() => {
    // Branch on the typed `reason` (a `LoopReason` union), not substring matching.
    if (loop?.state !== 'paused' || loop.reason !== 'circuit-breaker') return null;
    return { failureThreshold: loop.failureThreshold };
  }, [loop]);

  // Usage-aware throttle (spec 2026-07-11): the loop reflects a usage pause via the
  // typed `nc:loop` `reason` (`'usage'`). The window specifics for the banner come
  // from the `nc:usage` snapshot, not here — this is only the "is the loop
  // usage-paused" flag that gates the banner's visibility.
  const usagePaused = loop?.state === 'paused' && loop.reason === 'usage';

  const toggleAutoMode = useCallback(() => {
    // Disarm when armed (even if currently drained/paused), else arm.
    const fn = loop?.armed ? stopAutoLoop : startAutoLoop;
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

  return {
    autoMode,
    concurrency,
    breaker,
    usagePaused,
    toggleAutoMode,
    changeConcurrency,
    resume,
  };
}
