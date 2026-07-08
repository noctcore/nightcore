/** Indeterminate loading spinner for in-flight actions. */

/** Props for {@link Spinner}. */
interface SpinnerProps {
  /** Diameter in px. Defaults to 14 so it sits inline with a button's icon. */
  size?: number;
  /** Extra classes — e.g. a text color to tint the ring (it uses currentColor). */
  className?: string;
}

/** An indeterminate loading spinner for in-flight actions: a 3/4 ring in the
 *  current text color, spun with the `nc-spin` keyframe. The global
 *  prefers-reduced-motion rule freezes the rotation, leaving a static ring. */
export function Spinner({ size = 14, className }: SpinnerProps) {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 animate-[nc-spin_0.7s_linear_infinite] rounded-full border-2 border-current border-r-transparent ${className ?? ''}`}
      style={{ width: size, height: size }}
    />
  );
}
