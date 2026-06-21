import type { ReactNode } from 'react';

type BadgeTone = 'neutral' | 'primary' | 'roadmap';

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

/** A small JetBrains-Mono meta chip. `roadmap` tone tags M2/M3 affordances
 *  carried over from the design (kept visible, visually flagged). */
export function Badge({ children, tone = 'neutral', className }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[10px] font-medium ${TONES[tone]} ${className ?? ''}`}
    >
      {children}
    </span>
  );
}
