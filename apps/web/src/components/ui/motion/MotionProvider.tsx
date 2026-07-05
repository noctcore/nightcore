/** The app's single motion provider. */
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';

/**
 * Wraps the app in the motion/react runtime, mounted ONCE at the app root (above
 * `TaskStreamContext.Provider`, so motion internals never re-render on a per-frame
 * `nc:session` stream flush).
 *
 * - `LazyMotion features={domAnimation}` loads only the ~15-18KB gzip feature
 *   bundle (animations/variants/exit + hover/tap/focus gestures) and deliberately
 *   EXCLUDES `layout`/`layoutId`/drag/projection — a structural guardrail so the
 *   single most dangerous motion feature is a no-op on the virtualized board unless
 *   someone deliberately swaps to `domMax`.
 * - `strict` throws if anyone renders `motion.*` instead of `m.*` (which would pull
 *   the heavy full bundle), enforcing the lazy-feature discipline.
 * - `MotionConfig reducedMotion="user"` wires the OS reduced-motion setting to
 *   auto-disable transform/layout animations (keeping only opacity). The global CSS
 *   `prefers-reduced-motion` guard cannot reach motion/react's JS-driven springs, so
 *   this is the second, non-overlapping owner of reduced motion (CSS guard → CSS
 *   keyframes; MotionConfig → motion/react).
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
