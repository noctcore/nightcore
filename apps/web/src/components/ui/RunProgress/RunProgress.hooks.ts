import { useEffect, useRef, useState } from 'react';

/**
 * Live elapsed time for the running screen. While `running`, it ticks every 1s
 * from a local `setInterval` so the readout is never frozen waiting on the
 * backend. It anchors a wall-clock the moment a run starts — seeded from
 * `durationMs` (the last backend-reported elapsed) so a reload mid-run resumes
 * the right number instead of restarting at 0 — and keeps the displayed value
 * monotonic against later backend updates. Once the run is no longer `running`
 * it settles on the final `durationMs`.
 *
 * The latest `durationMs` is read through a ref so the interval only re-arms on
 * the `running` edge, never on every backend cost/token update (which would
 * jitter or restart the clock).
 */
export function useElapsedMs(running: boolean, durationMs: number): number {
  const seedRef = useRef(durationMs);
  seedRef.current = durationMs;
  const anchorRef = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) {
      anchorRef.current = null;
      return;
    }
    anchorRef.current = Date.now() - Math.max(0, seedRef.current);
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (!running || anchorRef.current === null) return durationMs;
  return Math.max(durationMs, now - anchorRef.current);
}
