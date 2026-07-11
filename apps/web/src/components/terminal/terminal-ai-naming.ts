/**
 * Terminal tab-title wiring for the precedence system (build spec — terminal round 2,
 * PR A): the rename callback that carries a title's precedence source, and the effect
 * that mirrors the opt-in AI-naming Setting into the module-level command-capture layer
 * and reflects a landed AI title back into the session list.
 *
 * Split out of `useTerminalView` (a feature-root hook, like `useTerminalTasks`) so that
 * hook stays under the file-size ratchet. The command capture itself lives in
 * `terminal-command-capture.ts`; this is only the React-facing seam.
 */
import { type Dispatch, type SetStateAction, useCallback, useEffect } from 'react';

import { setTerminalTitle, type TerminalSessionInfo, type TitleSource } from '@/lib/bridge';

import { lockSessionTitle, setAiNamingEnabled, subscribeTitleSuggestions } from './terminal-command-capture';
import { subscribeProcessTitle } from './terminal-process-title';

type SetSessions = Dispatch<SetStateAction<TerminalSessionInfo[]>>;

/** The rename callback for a live session (decision 5 + round-2 PR A): optimistic
 *  local update (title + its precedence `source`), then persist via `terminal_set_title`
 *  (trims + clears on blank). A `'manual'` or `'task'` rename LOCKS the tab against AI
 *  naming (the server enforces the precedence too); `source` defaults to `'manual'` so
 *  the tab/pane inline-rename callers stay unchanged. */
export function useRenameSession(setSessions: SetSessions) {
  return useCallback(
    (id: string, next: string, source: TitleSource = 'manual') => {
      const trimmed = next.trim();
      const title = trimmed === '' ? null : trimmed;
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title, titleSource: source } : s)),
      );
      if (source !== 'auto') lockSessionTitle(id);
      void setTerminalTitle(id, title, source);
    },
    [setSessions],
  );
}

/** Mirror the opt-in `terminal_ai_naming` Setting into the capture layer (which does
 *  nothing until it is on), and reflect a landed AI title back into the session list.
 *  The Rust command applies the name with `Auto` precedence guarded under the registry
 *  lock, so this only ever sees a title that actually stuck (round-2 PR A). */
export function useTerminalAiNaming(enabled: boolean, setSessions: SetSessions): void {
  useEffect(() => {
    setAiNamingEnabled(enabled);
  }, [enabled]);
  useEffect(
    () =>
      subscribeTitleSuggestions((id, title) => {
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, title, titleSource: 'auto' } : s)),
        );
      }),
    [setSessions],
  );
  // T11: reflect a landed process-title (OSC 0/2) into the session list. Always on (no
  // quota) and the LOWEST precedence — the Rust side only returns a title that actually
  // stuck, so this never overwrites a Manual/Task/AI name. Not gated on `enabled` (that
  // gate is the AI one-shot; the process-title is free and always available).
  useEffect(
    () =>
      subscribeProcessTitle((id, title) => {
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, title, titleSource: 'processTitle' } : s)),
        );
      }),
    [setSessions],
  );
}
