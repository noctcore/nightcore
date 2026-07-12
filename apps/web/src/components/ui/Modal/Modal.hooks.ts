/** Focus-trap, escape-to-close, and focus-restore behavior for Modal. */
import { useEffect, useRef } from 'react';

/** The house dialog rule for confirm-on-Enter: a confirmation fires only on
 *  Cmd/Ctrl+Enter, never on bare Enter (which is too easy to hit accidentally),
 *  and never from inside a `<textarea>` (where Enter inserts a newline and ⌘↵ is
 *  the field's own submit accelerator). Shared by {@link Modal}'s `onEnter` handler
 *  and by any dialog that wires its own keydown (e.g. FolderBrowserDialog), so
 *  every dialog's confirm accelerator is the same. */
export function isConfirmEnter(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'target'>,
): boolean {
  return (
    e.key === 'Enter' &&
    (e.metaKey || e.ctrlKey) &&
    !(e.target instanceof HTMLTextAreaElement)
  );
}

/** Retain the last non-nullish value so a presence-animated dialog keeps its
 *  content while it animates OUT — after the source data (a selected finding, a
 *  merge preview, a pending confirmation) has already cleared. Without this the
 *  panel would blank for the ~140ms exit. Returns the current value while present,
 *  the last-seen value while absent, and `null` until something has been present. */
export function useLastPresent<T>(value: T | null | undefined): T | null {
  const ref = useRef<T | null>(value ?? null);
  if (value !== null && value !== undefined) ref.current = value;
  return ref.current;
}

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
  active = true,
): React.RefObject<T | null> {
  const ref = useRef<T>(null);

  // Capture the opener when the dialog becomes active, so we can return focus to
  // it on close. Keyed on `active` (not bare mount) because a presence-animated
  // Modal stays mounted across its exit: focus must move IN when `open` flips true
  // and restore to the opener the moment it flips false (while the panel is still
  // animating out), not only when the node finally unmounts.
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) return;
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
      // Restore focus to the opener so a keyboard user isn't dumped at the top of
      // the document. This cleanup runs either when `active` flips false (the panel
      // is exiting but still in the DOM → focus is inside it) or on a hard unmount
      // (the node is detached → focus has fallen back to <body>). Handle both.
      const opener = openerRef.current;
      const node = ref.current;
      const focusInsideDialog =
        node !== null && node.contains(document.activeElement);
      if (
        opener !== null &&
        opener.isConnected &&
        (focusInsideDialog || document.activeElement === document.body)
      ) {
        opener.focus();
      }
    };
    // `initialFocus` is a static selector per call site; re-run only on `active`.
  }, [active]);

  useEffect(() => {
    if (!active) return;
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
  }, [onClose, active]);

  return ref;
}
