/**
 * The shared "attach a live session into a pane container" hook for the Terminal
 * feature. BOTH the tabbed `TerminalPane` and each grid `TerminalGridPane` mount
 * the SAME (remount-surviving) xterm instance owned by the module-level session
 * manager, so the attach/detach + one-time WebGL-renderer load lives here once
 * rather than being duplicated per pane shape.
 *
 * On mount it moves the session's persistent host element into the container and
 * wires input/resize; on unmount it detaches the host WITHOUT disposing the
 * instance, so switching views / toggling tabs⇄grid / zooming replays nothing and
 * loses no bytes. Re-attaches when the session id changes.
 */
import { useEffect, useRef } from 'react';

import { useToast } from '@/components/ui';

import { attachSession, ensureRenderer } from './terminal-session-manager';

/** Attach the cached xterm for `sessionId` into the returned container on mount,
 *  moving it back out (never disposing) on unmount. Also loads the WebGL renderer
 *  once if the session opted in, with a context-loss → DOM-fallback toast. */
export function useTerminalAttach(sessionId: string): {
  containerRef: React.RefObject<HTMLDivElement | null>;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    // `attachSession` opens the xterm on first attach (idempotent thereafter) and
    // returns a detach that removes (but does not dispose) the terminal host — so
    // switching away and back replays nothing and loses no bytes.
    const detach = attachSession(sessionId, container);
    // Load WebGL AFTER attach (the addon needs the opened canvas). `ensureRenderer`
    // is a one-time no-op for DOM sessions and idempotent across re-attaches.
    void ensureRenderer(sessionId, () => {
      toast.push({
        tone: 'info',
        title: 'GPU renderer unavailable',
        description: 'The terminal lost its WebGL context and switched to standard rendering.',
      });
    });
    return detach;
  }, [sessionId, toast]);

  return { containerRef };
}
