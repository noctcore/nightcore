/** Props for the {@link TerminalPane}. */
import type { TerminalSessionInfo } from '@/lib/bridge';

/** Props for the xterm host pane. The pane renders the identity chrome + the
 *  terminal surface for ONE session; the live xterm instance is owned by the
 *  feature's session manager (kept alive across remounts) and attached here. */
export interface TerminalPaneProps {
  /** The session this pane displays. */
  session: TerminalSessionInfo;
}
