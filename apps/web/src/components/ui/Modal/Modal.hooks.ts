/** Focus-trap, escape-to-close, and focus-restore behavior for Modal. */
import { useEffect, useRef } from 'react';

/** Focusable descendants a focus trap cycles through (Tab / Shift+Tab). Matches
 *  the standard interactive set, excluding anything explicitly removed from the
 *  tab order (`tabindex="-1"`) or disabled. */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Shared modal-dialog behavior (a11y) with a focus trap + focus restore:
 *  - moves focus INTO the dialog on mount (the element matching `initialFocus`,
 *    else the first focusable, else the dialog container);
 *  - traps Tab / Shift+Tab so focus can't escape to the inert background;
 *  - closes on Escape;
 *  - RESTORES focus to whatever was focused when the dialog opened (the opener)
 *    on unmount, so keyboard users aren't dumped at the top of the document.
 *
 *  Returns a ref to spread onto the dialog container. Click-outside/Enter stay
 *  the caller's concern (they vary per dialog). */
export function useModal<T extends HTMLElement>(
  onClose: () => void,
  initialFocus?: string,
): React.RefObject<T | null> {
  const ref = useRef<T>(null);

  // Capture the opener once, on mount, so we can return focus to it on close.
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const node = ref.current;
    const target =
      (initialFocus !== undefined
        ? node?.querySelector<HTMLElement>(initialFocus)
        : null) ??
      node?.querySelector<HTMLElement>(FOCUSABLE) ??
      node;
    target?.focus();
    return () => {
      // Restore focus to the opener on close, so a keyboard user isn't dumped at
      // the top of the document (the dialog node is already detached by the time
      // cleanup runs, so we can't test containment — restore whenever the opener
      // is still in the DOM). Skipped if the app moved focus elsewhere first.
      const opener = openerRef.current;
      if (opener !== null && opener.isConnected && document.activeElement === document.body) {
        opener.focus();
      }
    };
    // Run once on mount; `initialFocus` is a static selector per call site.
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const node = ref.current;
      if (node === null) return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeInside = node.contains(document.activeElement);
      // Wrap at the edges, and pull focus back in if it somehow escaped.
      if (e.shiftKey) {
        if (!activeInside || document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else if (!activeInside || document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return ref;
}
