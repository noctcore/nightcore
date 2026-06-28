/** Pulsing placeholder block for loading states. */

/** Props for {@link Skeleton}. */
interface SkeletonProps {
  /** Width/height/shape overrides (e.g. `h-3 w-24 rounded-md`). */
  className?: string;
}

/** A pulsing placeholder block for loading states. Purely presentational —
 *  `aria-hidden`, so the surrounding `role="status"` container owns the
 *  accessible loading announcement. Honors `prefers-reduced-motion`. */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={`nc-skeleton block rounded-md bg-white/[0.06] ${className ?? ''}`}
    />
  );
}
