/** TerminalPane state/effects: owns the container ref and the attach/detach of the
 *  session's persistent xterm instance across mounts (the `.tsx` stays a thin
 *  shell — no refs/effects in the component body). */
import { useEffect, useRef } from 'react';

import type { TerminalSessionInfo } from '@/lib/bridge';

import { attachSession } from '../terminal-session-manager';

/** Attach the session's cached xterm into this pane's container on mount and move
 *  it back out on unmount — WITHOUT disposing it, so the instance (and its live
 *  output stream) survives the shell's routed-view remount. Re-attaches when the
 *  active session id changes. */
export function useTerminalPane(session: TerminalSessionInfo) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    // `attachSession` returns a detach that removes (but does not dispose) the
    // terminal host — so switching away and back replays nothing and loses no bytes.
    return attachSession(session.id, container);
  }, [session.id]);

  return { containerRef };
}
