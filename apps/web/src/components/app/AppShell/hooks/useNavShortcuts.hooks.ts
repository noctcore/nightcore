import { useEffect } from 'react';

import { isTypingTarget } from '@/lib/typing-target';

import type { AppView, NavItem } from '../AppShell.types';

/** Wire the sidebar's single-letter nav hints (K/W/T/U/H/E/P/S) to actual
 *  navigation: a bare keypress matching a nav item's `hint` routes to its view.
 *  Ignored while a modifier is held (so app/OS chords still work) or focus is in a
 *  text field, and only active while `enabled` (the sidebar is on screen). Without
 *  this the Kbd chips are decorative — a broken promise of a power-user affordance. */
export function useNavShortcuts(
  nav: NavItem[],
  goto: (view: AppView) => void,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      // Let app/OS chords (⌘K, ⌃R, ⌥…) through untouched; only bare keys navigate.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      const item = nav.find((n) => n.hint.toLowerCase() === key);
      if (item === undefined) return;
      e.preventDefault();
      goto(item.view);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [nav, goto, enabled]);
}
