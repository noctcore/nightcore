/** TerminalPane state/effects: owns the container ref and the attach/detach of the
 *  session's persistent xterm instance across mounts (the `.tsx` stays a thin
 *  shell — no refs/effects in the component body). The attach itself lives in the
 *  shared {@link useTerminalAttach} hook, reused by the grid panes. */
import type { TerminalSessionInfo } from '@/lib/bridge';

import { useTerminalAttach } from '../terminal-attach';

/** Attach the session's cached xterm into this pane's container on mount and move
 *  it back out on unmount — WITHOUT disposing it, so the instance (and its live
 *  output stream) survives the shell's routed-view remount. Re-attaches when the
 *  active session id changes. Also loads the WebGL renderer once (if the session
 *  opted in), with a context-loss → DOM-fallback toast (decision 7). */
export function useTerminalPane(session: TerminalSessionInfo) {
  return useTerminalAttach(session.id);
}
