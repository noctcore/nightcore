/** Open/close state for the AutoModeOptions popover (kept out of the component
 *  body per the folder-per-component convention). */
import { type RefObject,useCallback, useEffect, useRef, useState } from 'react';

/** The popover control returned by {@link useAutoModeOptions}. */
export interface AutoModeOptionsControl {
  /** Whether the options panel is open. */
  open: boolean;
  /** Toggle the panel. */
  toggle: () => void;
  /** Close the panel. */
  close: () => void;
  /** Root ref for outside-click detection (wrap the trigger + panel). */
  rootRef: RefObject<HTMLDivElement | null>;
  /** The gear trigger ref — focus returns here on keyboard dismissal. */
  triggerRef: RefObject<HTMLButtonElement | null>;
}

/** Anchored-popover open state with outside-click + Esc close and keyboard focus
 *  management (focus the first option on open; return focus to the trigger on Esc),
 *  mirroring the `Menu` primitive's dismissal + first-item focus. */
export function useAutoModeOptions(): AutoModeOptionsControl {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const toggle = useCallback(() => setOpen((v) => !v), []);
  const close = useCallback(() => setOpen(false), []);
  // Keyboard dismissal returns focus to the gear so the tab position isn't lost to
  // <body> (an outside-click intentionally lets focus follow the click instead).
  const closeAndRestore = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    // Move focus into the panel on open (mirrors Menu's first-item focus) so the
    // options are immediately keyboard-operable.
    rootRef.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();

    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAndRestore();
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close, closeAndRestore]);

  return { open, toggle, close, rootRef, triggerRef };
}
