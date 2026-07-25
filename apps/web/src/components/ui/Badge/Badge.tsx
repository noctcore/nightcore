/** Small monospace meta chip for labelling status and tags. */

import type { BadgeProps, BadgeTone } from './Badge.types';

const TONES: Record<BadgeTone, string> = {
  neutral:
    'bg-white/[0.04] border border-border text-muted-foreground',
  primary: 'bg-primary/[0.18] text-primary',
  success: 'bg-success/[0.12] text-success',
  warning: 'bg-warning/[0.12] text-warning',
  destructive: 'bg-destructive/[0.12] text-destructive',
  info: 'bg-info/[0.12] text-info',
};

/** A small monospace meta chip. */
export function Badge({ children, tone = 'neutral', className }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-3xs font-medium ${TONES[tone]} ${className ?? ''}`}
    >
      {children}
    </span>
  );
}
