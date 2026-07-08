import type { ReactNode } from 'react';

/**
 * Visual tone of a {@link Badge}.
 * - `neutral`: muted, low-emphasis tag.
 * - `primary`: accent-colored emphasis tag.
 */
export type BadgeTone = 'neutral' | 'primary';

/** Props for {@link Badge}. */
export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}
