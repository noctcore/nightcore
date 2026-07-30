import { useCallback, useEffect, useState } from 'react';

import { isTypingTarget } from '@/lib/typing-target';

/** Whether another dialog already owns the screen. The shared `Modal` marks its panel
 *  `aria-modal="true"`, so this is the one honest signal available to a global
 *  listener: opening the cheatsheet ON TOP of a dialog would stack two focus traps and
 *  leave the user's Esc ambiguous. The sheet's own panel is excluded by the caller
 *  (while it is open, `?` closes it instead). */
function dialogIsOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/** The `?` cheatsheet's key layer. `?` opens the sheet from anywhere in the shell and
 *  closes it again; Esc-to-close is the shared Modal's job.
 *
 *  Guards, mirroring `useNavShortcuts` / `useBoardShortcuts`:
 *   - never while the user is typing (`isTypingTarget` — `?` is a literal character,
 *     so this is the guard that matters most here);
 *   - never under ⌘/Ctrl/Alt, so app and OS chords pass through untouched. Shift is
 *     NOT excluded: on most layouts `?` IS Shift+/ , so rejecting Shift would make the
 *     shortcut unreachable;
 *   - never over another dialog (see {@link dialogIsOpen}).
 *
 *  `enabled` is false during the splash and the onboarding wizard, which own the whole
 *  window and advertise their own affordances. */
export function useShortcutSheet(enabled: boolean): {
  open: boolean;
  /** Open it from a click (the sidebar's `?` chip), not just the key. */
  show: () => void;
  close: () => void;
} {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!enabled) {
      setOpen(false);
      return;
    }
    const handler = (e: KeyboardEvent) => {
      if (e.key !== '?') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      // Read the DOM outside the updater (an updater must stay pure). When the sheet
      // itself is open this is true — and that branch closes it, so the flag only ever
      // BLOCKS on a dialog that belongs to someone else.
      const blocked = dialogIsOpen();
      setOpen((current) => (current ? false : !blocked));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled]);

  return { open, show, close };
}
