/** Props for the {@link TerminalGridPane} — one live session's pane inside the grid
 *  view (decision 1, PR 2). */
import type { TerminalSessionInfo } from '@/lib/bridge';

/** Props for a grid pane. The pane hosts ONE live session's (remount-surviving)
 *  xterm, a drag grip + drop target for reorder, an inline-rename title, an unread
 *  badge, and a zoom toggle. Presentational over the shared session manager + the
 *  grid's `<DndContext>`; the parent owns order + zoom + rename state. */
export interface TerminalGridPaneProps {
  /** The session this pane displays. */
  session: TerminalSessionInfo;
  /** Unread-output count for this session (decision 6c) — badged while it is a
   *  zoomed-away / off-screen pane. */
  unread: number;
  /** Whether this session is "ungoverned" (task-linked or Claude-launched,
   *  decision 3) — a warning marker in the pane chrome. */
  ungoverned: boolean;
  /** Whether the one-click `claude` launch is available for this session (POSIX
   *  shell only, decision 3) — gates the header Launch-Claude button, matching the
   *  tab pane. */
  canLaunch: boolean;
  /** Launch `claude` in this terminal (decision 3): types the composed `cd … &&
   *  claude` command into the PTY (YOLO flag respected upstream). */
  onLaunchClaude: () => void;
  /** Whether this pane is the single zoomed pane (full-view). */
  zoomed: boolean;
  /** Whether reorder drag is enabled (false while any pane is zoomed). */
  draggable: boolean;
  /** Whether broadcast input is armed (round-2 PR B): this pane is RECEIVING the
   *  fanned-out keystrokes, so it shows the LOUD amber ring + "BCAST" badge. */
  broadcasting: boolean;
  /** Rename this session (decision 5): double-click the title → inline edit. */
  onRename: (id: string, title: string) => void;
  /** Toggle this pane's zoom (header button; also ⌘⇧E on the active pane). */
  onToggleZoom: (id: string) => void;
  /** Mark this pane the active one (its title click) — the ⌘⇧E zoom target. */
  onActivate: (id: string) => void;
}
