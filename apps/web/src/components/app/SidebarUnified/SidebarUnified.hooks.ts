/** Dismiss behavior for the project-switcher popover. */
import { useEffect, useRef } from 'react';

/** Close the switcher on Escape or an outside pointer-down while it is open —
 *  the popover otherwise only closed via re-toggle, pick, or navigation. Mirrors
 *  the shared Menu's dismiss pattern (window pointerdown + keydown, active only
 *  while open). Returns a ref to spread onto the switcher root so clicks on the
 *  trigger or inside the panel don't count as "outside". */
export function useSwitcherDismiss(open: boolean, onClose: () => void) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  return rootRef;
}
