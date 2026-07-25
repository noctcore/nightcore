/** A lightweight hover/focus tooltip anchored to its trigger. */
import type { ReactElement, ReactNode } from 'react';

import { useTooltip } from './Tooltip.hooks';

/** Props for {@link Tooltip}. */
export interface TooltipProps {
  /** The tip content — kept short (a label or terse hint). */
  label: ReactNode;
  /** The trigger element the tip describes. */
  children: ReactElement;
  /** Which side of the trigger the tip sits on. Defaults to `top`. */
  side?: 'top' | 'bottom';
  /** Hover/focus dwell before the tip appears, in ms. Defaults to 300. */
  delayMs?: number;
  /** Extra wrapper classes (e.g. `shrink-0` so a flex trigger keeps its size). */
  className?: string;
}

/**
 * A minimal, dependency-free tooltip: reveals `label` above (or below) `children`
 * after a short dwell on hover OR keyboard focus, and hides on leave / blur / Esc.
 * Positioned relative to the trigger (no portal) with the same `bg-popover` +
 * border chrome as Menu, and the shared `nc-popover-rise` entrance (reduced-motion
 * safe via the global CSS rule). The tip is decorative (`role="tooltip"`, not wired
 * as an accessible name) — give the trigger its own `aria-label`.
 */
export function Tooltip({ label, children, side = 'top', delayMs = 300, className }: TooltipProps) {
  const { open, handlers } = useTooltip(delayMs);

  return (
    <span className={`relative inline-flex ${className ?? ''}`} {...handlers}>
      {children}
      {open && (
        <span
          role="tooltip"
          className={`nc-popover-rise pointer-events-none absolute left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-2xs font-medium text-foreground shadow-2xl ${
            side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          }`}
        >
          {label}
        </span>
      )}
    </span>
  );
}
