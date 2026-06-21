interface StatusDotProps {
  /** Tailwind background class for the dot (e.g. `bg-primary`). */
  colorClass: string;
  /** Pulse for active/streaming states. */
  pulse?: boolean;
  /** Add the design's soft glow ring around the dot. */
  glow?: boolean;
}

/** A small status indicator dot. Color is passed in as a class so this
 *  primitive stays free of any feature-specific status vocabulary. */
export function StatusDot({ colorClass, pulse, glow }: StatusDotProps) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${colorClass} ${pulse ? 'animate-[nc-pulse_1.4s_ease-in-out_infinite]' : ''} ${glow ? 'shadow-[0_0_8px_currentColor]' : ''}`}
    />
  );
}
