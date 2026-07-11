import { useEffect } from 'react';

import { BOARD_SEARCH_INPUT_ID } from '@/components/board';
import { isTypingTarget } from '@/lib/typing-target';

/** The board's keyboard layer (T13): wires the advertised-but-dead single-key hints —
 *  `N` opens the New Task dialog, `/` focuses the board search, and `Esc` closes the
 *  open task drawer. Modifier chords and typing surfaces are ignored (so app/OS chords
 *  and real typing pass through), and the whole layer is inert unless `enabled` (the
 *  board is on screen with no modal open). Mirrors `useNavShortcuts` — one window-level
 *  keydown listener with the shared `isTypingTarget` guard. */
export function useBoardShortcuts({
  enabled,
  drawerOpen,
  onNewTask,
  onCloseDrawer,
}: {
  /** Active only while the board view is on screen and no modal is open. */
  enabled: boolean;
  /** Whether a task detail drawer is open (gates the Esc-to-close). */
  drawerOpen: boolean;
  onNewTask: () => void;
  onCloseDrawer: () => void;
}): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      // Escape closes the open drawer — but only from a non-typing target, so Esc while
      // typing in the search box keeps its native behavior (and never steals it).
      if (e.key === 'Escape') {
        if (drawerOpen && !isTypingTarget(e.target)) {
          e.preventDefault();
          onCloseDrawer();
        }
        return;
      }
      // Let app/OS chords (⌘K, ⌃R, …) through; only bare keys act. Never steal a
      // keystroke while the user is typing in a field.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === 'n') {
        e.preventDefault();
        onNewTask();
      } else if (key === '/') {
        e.preventDefault();
        document.getElementById(BOARD_SEARCH_INPUT_ID)?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled, drawerOpen, onNewTask, onCloseDrawer]);
}
