/** Props for the {@link TerminalTabs} bar. */
import type { PersistedTerminalInfo, TerminalSessionInfo } from '@/lib/bridge';

/** Props for the terminal tabs bar. Presentational: the parent owns the session
 *  list, the active selection, and the open/close/new-tab actions. Restored
 *  (read-only) tabs from a prior run render after the live ones, visually distinct
 *  (decision 3). */
export interface TerminalTabsProps {
  /** The live sessions, one tab each. */
  sessions: TerminalSessionInfo[];
  /** Restored (dead) sessions from a prior run — read-only tabs, rendered dimmed
   *  after the live tabs. */
  restored: PersistedTerminalInfo[];
  /** The active tab's id — either a live session or a restored one (ids never
   *  collide; a restored session is dead). `null` when there are none. */
  activeId: string | null;
  /** Select a tab (live or restored). */
  onSelect: (id: string) => void;
  /** Request closing a LIVE tab (the parent confirms + kills). */
  onClose: (id: string) => void;
  /** Dismiss a RESTORED tab (deletes its persisted scrollback). */
  onDismiss: (id: string) => void;
  /** Open the new-terminal picker. */
  onNewTab: () => void;
  /** False at the live-session cap — disables the new-tab button. */
  canAddTab: boolean;
}
