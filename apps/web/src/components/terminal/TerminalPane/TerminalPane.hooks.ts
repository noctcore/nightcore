/** TerminalPane state/effects: owns the container ref, the attach/detach of the
 *  session's persistent xterm instance across mounts, the in-pane search state, and
 *  the jump-to-bottom chip's scroll tracking (the `.tsx` stays a thin shell — no
 *  refs/effects in the component body). The attach itself lives in the shared
 *  {@link useTerminalAttach} hook, and the search in {@link useTerminalSearch} — both
 *  reused by the grid panes. */
import { type RefObject, useCallback, useEffect, useState } from 'react';

import type { TerminalSessionInfo } from '@/lib/bridge';

import { useTerminalAttach } from '../terminal-attach';
import { type TerminalSearch, useTerminalSearch } from '../terminal-search';
import { onSessionScroll, scrollSessionToBottom } from '../terminal-session-manager';

/** The jump-to-bottom chip state a pane binds to. */
export interface TerminalJumpToBottom {
  /** Whether the viewport is scrolled up from the buffer bottom (show the chip). */
  readonly show: boolean;
  /** Scroll the pane's terminal back to the bottom of its buffer. */
  readonly toBottom: () => void;
}

/** Track whether the session's viewport is at the buffer bottom, so the pane can
 *  float a jump-to-bottom chip while it's scrolled up. `onSessionScroll` emits the
 *  current state immediately, so `true` is a safe (chip-hidden) initial value. */
function useJumpToBottom(sessionId: string): TerminalJumpToBottom {
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => onSessionScroll(sessionId, setAtBottom), [sessionId]);
  const toBottom = useCallback(() => scrollSessionToBottom(sessionId), [sessionId]);
  return { show: !atBottom, toBottom };
}

/** Attach the session's cached xterm into this pane's container on mount and move
 *  it back out on unmount — WITHOUT disposing it, so the instance (and its live
 *  output stream) survives the shell's routed-view remount. Re-attaches when the
 *  active session id changes. Also loads the WebGL renderer once (if the session
 *  opted in), with a context-loss → DOM-fallback toast (decision 7), drives the
 *  ⌘F search bar (spec PR 3c), and tracks scroll for the jump-to-bottom chip. */
export function useTerminalPane(session: TerminalSessionInfo): {
  containerRef: RefObject<HTMLDivElement | null>;
  search: TerminalSearch;
  jump: TerminalJumpToBottom;
} {
  const { containerRef } = useTerminalAttach(session.id);
  const search = useTerminalSearch(session.id);
  const jump = useJumpToBottom(session.id);
  return { containerRef, search, jump };
}
