/** TerminalPane state/effects: owns the container ref and the attach/detach of the
 *  session's persistent xterm instance across mounts (the `.tsx` stays a thin
 *  shell — no refs/effects in the component body). */
import { useEffect, useRef } from 'react';

import { useToast } from '@/components/ui';
import type { TerminalSessionInfo } from '@/lib/bridge';

import { attachSession, ensureRenderer } from '../terminal-session-manager';

/** Attach the session's cached xterm into this pane's container on mount and move
 *  it back out on unmount — WITHOUT disposing it, so the instance (and its live
 *  output stream) survives the shell's routed-view remount. Re-attaches when the
 *  active session id changes. Also loads the WebGL renderer once (if the session
 *  opted in), with a context-loss → DOM-fallback toast (decision 7). */
export function useTerminalPane(session: TerminalSessionInfo) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    // `attachSession` opens the xterm on first attach (idempotent thereafter) and
    // returns a detach that removes (but does not dispose) the terminal host — so
    // switching away and back replays nothing and loses no bytes.
    const detach = attachSession(session.id, container);
    // Load WebGL AFTER attach (the addon needs the opened canvas). `ensureRenderer`
    // is a one-time no-op for DOM sessions and idempotent across re-attaches.
    void ensureRenderer(session.id, () => {
      toast.push({
        tone: 'info',
        title: 'GPU renderer unavailable',
        description: 'The terminal lost its WebGL context and switched to standard rendering.',
      });
    });
    return detach;
  }, [session.id, toast]);

  return { containerRef };
}
