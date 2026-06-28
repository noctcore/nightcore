/** Phase cross-fade and focus-management hooks for RunLifecycleShell. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { RunPhase } from './RunLifecycleShell.types';

/**
 * Drive a 150ms opacity cross-fade whenever `phase` changes. Returns the opacity
 * to apply to the screen body: it drops to `0` the frame the new screen mounts
 * (via `useLayoutEffect`, before paint, so there's no flash of the old screen)
 * then animates back to `1` on the next frame through the caller's
 * `transition-opacity duration-150`.
 *
 * Reduced-motion users get the instant result for free: the global stylesheet
 * collapses every `transition-duration`, so the `0 → 1` swap is imperceptible.
 */
export function usePhaseFade(phase: RunPhase): number {
  const [opacity, setOpacity] = useState(1);
  const previous = useRef(phase);

  useLayoutEffect(() => {
    if (previous.current === phase) return;
    previous.current = phase;
    setOpacity(0);
    const frame = requestAnimationFrame(() => setOpacity(1));
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  return opacity;
}

/**
 * Move focus onto the freshly-swapped screen body whenever `phase` CHANGES, so a
 * keyboard / screen-reader user isn't dropped to `<body>` when the screen remounts
 * under the opacity fade — most importantly on the auto-transition into RESULTS.
 *
 * Returns a ref to spread onto the screen-body container (which must carry
 * `tabIndex={-1}` to be programmatically focusable). Focus is moved only on a
 * phase change, never on initial mount, so it doesn't steal focus when the view
 * first renders. The container itself isn't a tab stop (`-1`).
 */
export function usePhaseFocus(phase: RunPhase): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef(phase);

  useEffect(() => {
    if (previous.current === phase) return;
    previous.current = phase;
    ref.current?.focus();
  }, [phase]);

  return ref;
}
