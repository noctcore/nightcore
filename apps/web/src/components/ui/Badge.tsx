/** Small monospace meta chip for labelling status and tags. */
import type { ReactNode } from 'react';

/**
 * Visual tone of a {@link Badge}.
 * - `neutral`: muted, low-emphasis tag.
 * - `primary`: accent-colored emphasis tag.
 * - `roadmap`: accent tag with extra letter-spacing, used to flag not-yet-built
 *   or future affordances so they read as forthcoming.
 */
type BadgeTone = 'neutral' | 'primary' | 'roadmap';

/** Props for {@link Badge}. */
interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}

const TONES: Record<BadgeTone, string> = {
  neutral:
    'bg-white/[0.04] border border-border text-muted-foreground',
  primary: 'bg-primary/[0.18] text-primary',
  roadmap: 'bg-primary/[0.18] text-primary tracking-[0.04em]',
};

/**
 * A small monospace meta chip. The `roadmap` tone visually flags affordances
 * that are surfaced but not yet built, keeping them visible and distinct.
 */
export function Badge({ children, tone = 'neutral', className }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[10px] font-medium ${TONES[tone]} ${className ?? ''}`}
    >
      {children}
    </span>
  );
}
