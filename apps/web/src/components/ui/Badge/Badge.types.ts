import type { ReactNode } from 'react';

/**
 * Visual tone of a {@link Badge}.
 * - `neutral`: muted, low-emphasis tag.
 * - `primary`: accent-colored emphasis tag.
 * - `success` / `warning` / `destructive` / `info`: semantic status tags, each
 *   a soft tinted fill in its own status color (the tones features currently
 *   hand-roll as `bg-<status>/[0.12] text-<status>`).
 */
export type BadgeTone =
  | 'neutral'
  | 'primary'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'info';

/** Props for {@link Badge}. */
export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}
