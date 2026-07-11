/** Props for the {@link TerminalTabs} bar. */
import type { ReactNode } from 'react';

import type { PersistedTerminalInfo, TerminalSessionInfo } from '@/lib/bridge';

import type { TerminalViewMode } from '../terminal-layout';

/** Task-integration additions to the tabs bar (cockpit spec PR 4, decisions 2 & 3),
 *  kept a separate base so the (already wide) {@link TerminalTabsProps} stays under
 *  the props budget — `extends` members are not counted. */
export interface TerminalTabsTaskbar {
  /** Session ids marked "ungoverned" (decision 3): task-linked or Claude-launched —
   *  a warning marker on the tab. Missing ids read as governed. */
  ungovernedIds: ReadonlySet<string>;
  /** A slot rendered in the tab bar (the task-inject dropdown, decision 2). */
  headerSlot?: ReactNode;
}

/** Props for the terminal tabs bar. Presentational: the parent owns the session
 *  list, the active selection, and the open/close/new-tab actions. Restored
 *  (read-only) tabs from a prior run render after the live ones, visually distinct
 *  (decision 3). */
export interface TerminalTabsProps extends TerminalTabsTaskbar {
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
  /** Rename a LIVE tab (decision 5): the parent optimistically updates + persists.
   *  An empty title clears the name back to the cwd-leaf label. */
  onRename: (id: string, title: string) => void;
  /** Per-session unread-output counts (decision 6c) — a badge on inactive tabs.
   *  Missing ids read as 0. */
  unread: Readonly<Record<string, number>>;
  /** The current terminal-body view mode (decision 1, PR 2): tabs or grid. */
  viewMode: TerminalViewMode;
  /** Flip between the tabs and grid view modes. */
  onToggleViewMode: () => void;
}
