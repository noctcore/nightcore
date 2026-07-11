/** TerminalPane state/effects: owns the container ref, the attach/detach of the
 *  session's persistent xterm instance across mounts, and the in-pane search state
 *  (the `.tsx` stays a thin shell — no refs/effects in the component body). The
 *  attach itself lives in the shared {@link useTerminalAttach} hook, and the search
 *  in {@link useTerminalSearch} — both reused by the grid panes. */
import type { RefObject } from 'react';

import type { TerminalSessionInfo } from '@/lib/bridge';

import { useTerminalAttach } from '../terminal-attach';
import { type TerminalSearch, useTerminalSearch } from '../terminal-search';

/** Attach the session's cached xterm into this pane's container on mount and move
 *  it back out on unmount — WITHOUT disposing it, so the instance (and its live
 *  output stream) survives the shell's routed-view remount. Re-attaches when the
 *  active session id changes. Also loads the WebGL renderer once (if the session
 *  opted in), with a context-loss → DOM-fallback toast (decision 7), and drives the
 *  ⌘F search bar (spec PR 3c). */
export function useTerminalPane(session: TerminalSessionInfo): {
  containerRef: RefObject<HTMLDivElement | null>;
  search: TerminalSearch;
} {
  const { containerRef } = useTerminalAttach(session.id);
  const search = useTerminalSearch(session.id);
  return { containerRef, search };
}
