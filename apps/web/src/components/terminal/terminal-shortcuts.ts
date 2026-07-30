/**
 * View-scoped keyboard shortcuts for the Terminal cockpit (spec PR 3a): ⌘T / Ctrl+T
 * opens the new-terminal picker, ⌘W / Ctrl+W closes the active terminal (through the
 * confirm dialog), and ⌘1..9 selects the Nth tab/pane (#405). Zoom (⌘⇧E) lives in
 * `useTerminalLayout` (grid-only) and is left there.
 *
 * ⌘1..9 selects by DISPLAY order, not by session age, so the number matches what the
 * user sees; ⌘9 is the LAST pane (the field's convention), not the ninth — with the
 * 12-session cap that is the only reachable way to jump to a tail tab. Selecting also
 * moves keyboard focus into that terminal, so the very next keystroke (and ⌘W) act on
 * the pane the user just jumped to rather than the one they left.
 *
 * The listener is bound on `window` but only exists WHILE the Terminal view is
 * mounted (this hook is called from `useTerminalView`), so it is naturally
 * view-scoped — navigating away unmounts the view and removes the listener.
 *
 * Two traps this handler defends (spec § 9m):
 *  - **⌘W MUST `preventDefault()`** or WKWebView closes the whole app window.
 *  - The chords are **modifier-gated**, which the bare-letter nav shortcuts
 *    (`useNavShortcuts`) explicitly ignore — so typing in a terminal never navigates
 *    and these never collide. The keymap (`installKeymap`) separately swallows the
 *    same chords so xterm doesn't also forward them to the PTY.
 */
import { useEffect, useRef } from 'react';

import { isMacPlatform } from './terminal-platform';

/** What the Terminal shortcuts drive. Kept out of the view's hook return surface —
 *  the shortcuts are a pure side effect (no rendered state). */
export interface TerminalShortcutsInput {
  /** The active tab/session id, or `null` (empty state) — the ⌘W close target. */
  readonly activeId: string | null;
  /** Live session ids in DISPLAY order — the ⌘1..9 targets (#405). */
  readonly orderedIds: readonly string[];
  /** Select a session (⌘1..9). The view also moves terminal focus to it. */
  readonly onSelect: (id: string) => void;
  /** Whether a new terminal can still be opened (under the session cap) — ⌘T no-ops
   *  at the cap, matching the disabled "+" button. */
  readonly canAddTab: boolean;
  /** Open the new-terminal picker (⌘T). */
  readonly onNewTab: () => void;
  /** Request close of the active terminal (⌘W) — routes through the confirm dialog. */
  readonly onCloseActive: (id: string) => void;
}

/** The ⌘`n` target in DISPLAY order: 1-based, with `9` meaning THE LAST session (the
 *  field's convention — VS Code, iTerm2, Chrome all do this) rather than literally the
 *  ninth, so a tail tab past nine is still reachable. `null` when the slot is empty.
 *  Pure so the mapping is unit-testable without a keyboard. */
export function nthSessionId(orderedIds: readonly string[], n: number): string | null {
  if (orderedIds.length === 0 || n < 1 || n > 9) return null;
  if (n === 9) return orderedIds.at(-1) ?? null;
  return orderedIds[n - 1] ?? null;
}

/** Bind the ⌘T / ⌘W / ⌘1..9 cockpit shortcuts for the lifetime of the Terminal view. The
 *  latest inputs are read through a ref so the window listener binds exactly once
 *  (no rebind churn as the active tab / cap changes). */
export function useTerminalShortcuts(input: TerminalShortcutsInput): void {
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const primary = isMacPlatform() ? e.metaKey : e.ctrlKey;
      // Only the bare primary modifier — shift is the zoom chord (handled in the
      // layout hook); alt/the other modifier are left for the OS.
      if (!primary || e.shiftKey || e.altKey) return;
      if (isMacPlatform() ? e.ctrlKey : e.metaKey) return;

      const key = e.key.toLowerCase();
      if (key === 't') {
        e.preventDefault();
        if (latest.current.canAddTab) latest.current.onNewTab();
      } else if (key === 'w') {
        // CRITICAL: WKWebView closes the app window on ⌘W unless prevented (§ 9m).
        e.preventDefault();
        const id = latest.current.activeId;
        if (id !== null) latest.current.onCloseActive(id);
      } else if (/^[1-9]$/.test(key)) {
        // ⌘1..9 (#405). Always prevented, even when the slot is empty — otherwise the
        // webview's own tab-switch default fires and navigates out of the app.
        e.preventDefault();
        const target = nthSessionId(latest.current.orderedIds, Number(key));
        if (target !== null) latest.current.onSelect(target);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
