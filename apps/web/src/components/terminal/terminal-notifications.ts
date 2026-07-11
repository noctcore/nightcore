/**
 * Terminal command-completion desktop notifications (T11).
 *
 * When a shell emits a standard completion/notification escape — an OSC 9 (iTerm/growl),
 * OSC 99 (kitty), OSC 777 (urxvt notify), or a BEL — the terminal-attention parser fires
 * a completion signal. This layer turns that signal into a DESKTOP notification, but only
 * when the user can't already see the terminal: the pane is off-screen OR the window is
 * unfocused/hidden. It is OUTPUT-SIDE only (it never reaches into the PTY) and uses ONLY
 * the standard OSC/BEL signals — never the rejected busy/idle output-content heuristics.
 *
 * WHY MODULE-LEVEL (not just a view hook): the subscription is registered ONCE (on the
 * first terminal-view mount) and never torn down, so a command finishing in a background
 * terminal notifies even after the user navigates AWAY from the Terminal view — which is
 * exactly the case worth notifying about. The React hook only feeds it the live tab
 * labels + the setting flag while the view is mounted (renames only happen there).
 */
import { useEffect } from 'react';

import { notifyTerminalComplete, type TerminalSessionInfo } from '@/lib/bridge';

import { getVisibleIds, subscribeCompletion } from './terminal-attention';
import { displayTitle } from './terminal-shared';

/** The setting (`terminal_bell_notify`), mirrored here so the module-level listener can
 *  read it. Defaults ON — an OSC/BEL is an explicit signal, not a busy/idle guess. */
let enabled = true;
/** Live tab labels by session id, synced from the view so a notification names the tab
 *  by its current (possibly renamed) title rather than the cwd leaf. */
const labels = new Map<string, string>();
/** Registered exactly once — the subscription then lives for the app's lifetime so
 *  off-view completions still notify. */
let subscribed = false;

/** Whether a completion should surface a desktop notification: the setting is on AND
 *  the user can't already see the terminal (its pane is off-screen, or the window is
 *  unfocused/hidden). Exported pure for unit testing without a real notification. */
export function shouldNotifyCompletion(opts: {
  enabled: boolean;
  visible: boolean;
  windowFocused: boolean;
}): boolean {
  if (!opts.enabled) return false;
  // Visible AND focused ⇒ the user is looking right at it — don't interrupt.
  return !(opts.visible && opts.windowFocused);
}

function handleCompletion(id: string): void {
  const windowFocused = typeof document !== 'undefined' && document.hasFocus();
  if (!shouldNotifyCompletion({ enabled, visible: getVisibleIds().has(id), windowFocused })) {
    return;
  }
  void notifyTerminalComplete(labels.get(id) ?? '');
}

/** Register the completion→notification subscription once (idempotent). */
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  subscribeCompletion(handleCompletion);
}

/** Mirror the `terminal_bell_notify` setting + the live tab labels into the module-level
 *  notification layer, and register its (app-lifetime) completion subscription on first
 *  mount. Called from the Terminal view so labels track renames while it is open; the
 *  subscription then keeps firing after the user navigates away. */
export function useTerminalCompletionNotifications(
  sessions: readonly TerminalSessionInfo[],
  bellNotify: boolean,
): void {
  useEffect(() => {
    ensureSubscribed();
  }, []);
  useEffect(() => {
    enabled = bellNotify;
  }, [bellNotify]);
  useEffect(() => {
    labels.clear();
    for (const s of sessions) labels.set(s.id, displayTitle(s));
  }, [sessions]);
}
