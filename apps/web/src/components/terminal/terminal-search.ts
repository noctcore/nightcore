/**
 * In-pane search-in-scrollback for the Terminal cockpit (spec PR 3c), shared by the
 * tabbed `TerminalPane` and each grid `TerminalGridPane`. Owns the find bar's
 * open/query/no-match state and drives the session manager's per-session
 * `@xterm/addon-search` (findNext / findPrevious / clear).
 *
 * ⌘F / Ctrl+F opens the bar. The chord is captured by a NATIVE keydown listener on
 * the pane's terminal region (the returned `rootRef`), which fires for keydowns
 * bubbling out of xterm's hidden textarea — so it only triggers for the focused pane
 * (a native listener, not a JSX handler on a non-interactive div). `installKeymap`
 * separately swallows ⌘F so xterm never forwards it to the PTY. The find bar itself
 * handles Enter / Shift+Enter / Esc.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import { isMacPlatform } from './terminal-platform';
import { clearSearch, focusSession, searchNext, searchPrevious } from './terminal-session-manager';

/** The find-bar state + actions a pane binds to. */
export interface TerminalSearch {
  /** Whether the find bar is shown. */
  readonly open: boolean;
  /** The current query. */
  readonly query: string;
  /** True when a non-empty query matched nothing (drives the "no results" style). */
  readonly noMatch: boolean;
  /** Ref for the pane's terminal region — a native ⌘F / Ctrl+F listener is bound to
   *  it, opening the bar when the focused terminal's textarea bubbles the chord. */
  readonly rootRef: RefObject<HTMLDivElement | null>;
  /** Update the query and re-run an incremental search from the top. */
  readonly onQueryChange: (value: string) => void;
  /** Jump to the next match. */
  readonly next: () => void;
  /** Jump to the previous match. */
  readonly prev: () => void;
  /** Close the bar, clear decorations, and refocus the terminal. */
  readonly close: () => void;
}

/** Drive the find bar for one session's terminal. */
export function useTerminalSearch(sessionId: string): TerminalSearch {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [noMatch, setNoMatch] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Native ⌘F / Ctrl+F listener on the pane's terminal region: keydowns bubble here
  // from xterm's hidden textarea, so the bar opens for the focused pane only. Bound
  // natively (not a JSX handler) so the terminal surface stays a plain container.
  useEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const primary = isMacPlatform() ? e.metaKey : e.ctrlKey;
      if (primary && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setOpen(true);
      }
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, []);

  const onQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (value === '') {
        clearSearch(sessionId);
        setNoMatch(false);
        return;
      }
      // Incremental: search from the current viewport as the user types.
      setNoMatch(!searchNext(sessionId, value, true));
    },
    [sessionId],
  );

  const next = useCallback(() => {
    if (query === '') return;
    setNoMatch(!searchNext(sessionId, query, false));
  }, [sessionId, query]);

  const prev = useCallback(() => {
    if (query === '') return;
    setNoMatch(!searchPrevious(sessionId, query));
  }, [sessionId, query]);

  const close = useCallback(() => {
    clearSearch(sessionId);
    setOpen(false);
    setNoMatch(false);
    focusSession(sessionId);
  }, [sessionId]);

  return { open, query, noMatch, rootRef, onQueryChange, next, prev, close };
}
