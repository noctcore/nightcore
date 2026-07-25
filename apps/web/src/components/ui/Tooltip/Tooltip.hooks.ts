/** The open-state machine and trigger handlers backing the Tooltip primitive. */
import type { FocusEvent, KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

/** True only for keyboard focus, so the tip shows on Tab but not on a pointer click. */
function isKeyboardFocus(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.matches(':focus-visible');
}

/** The handlers the Tooltip spreads onto its wrapper element. */
interface TooltipTriggerHandlers {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: (e: FocusEvent) => void;
  onBlur: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}

/**
 * Drives {@link Tooltip}: a delayed reveal on hover / keyboard focus and an
 * immediate hide on leave / blur / Esc, with the pending reveal dropped on
 * unmount. Returns the current visibility plus the handlers to spread on the
 * wrapper.
 */
export function useTooltip(delayMs: number): { open: boolean; handlers: TooltipTriggerHandlers } {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const show = () => {
    clear();
    timer.current = setTimeout(() => setOpen(true), delayMs);
  };
  const hide = () => {
    clear();
    setOpen(false);
  };

  // Drop any pending reveal if the trigger unmounts mid-dwell.
  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  return {
    open,
    handlers: {
      onMouseEnter: show,
      onMouseLeave: hide,
      onFocus: (e) => {
        if (isKeyboardFocus(e.target)) show();
      },
      onBlur: hide,
      onKeyDown: (e) => {
        if (e.key === 'Escape') hide();
      },
    },
  };
}
