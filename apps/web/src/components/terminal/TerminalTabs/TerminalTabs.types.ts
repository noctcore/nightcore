/** Props for the {@link TerminalTabs} bar. */
import type { TerminalSessionInfo } from '@/lib/bridge';

/** Props for the terminal tabs bar. Presentational: the parent owns the session
 *  list, the active selection, and the open/close/new-tab actions. */
export interface TerminalTabsProps {
  /** The live sessions, one tab each. */
  sessions: TerminalSessionInfo[];
  /** The active tab's session id (`null` when there are none). */
  activeId: string | null;
  /** Select a tab. */
  onSelect: (id: string) => void;
  /** Request closing a tab (the parent confirms + kills). */
  onClose: (id: string) => void;
  /** Open the new-terminal picker. */
  onNewTab: () => void;
  /** False at the live-session cap — disables the new-tab button. */
  canAddTab: boolean;
}
