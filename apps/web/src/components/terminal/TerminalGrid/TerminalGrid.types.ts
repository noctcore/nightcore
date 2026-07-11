/** Props for the {@link TerminalGrid} — the grid view mode (decision 1, PR 2). */
import type { TerminalSessionInfo } from '@/lib/bridge';

import type { TerminalAttention } from '../terminal-attention';

/** Props for the grid view. Presentational over the shared session manager: the
 *  parent (the Terminal view) owns the ordered session list, the zoom + reorder
 *  state, and the rename/activate actions. */
export interface TerminalGridProps {
  /** The live sessions, already in the persisted display order. */
  sessions: TerminalSessionInfo[];
  /** Per-session 3-state attention (T11): idle / has-output / needs-attention.
   *  Missing ids read as idle. */
  attention: Readonly<Record<string, TerminalAttention>>;
  /** Session ids marked "ungoverned" (decision 3) — a warning marker per pane. */
  ungovernedIds: ReadonlySet<string>;
  /** Whether a session's shell can run the composed `claude` launch (POSIX only,
   *  decision 3) — gates each pane's Launch-Claude button, matching the tab pane. */
  canLaunchClaude: (session: TerminalSessionInfo) => boolean;
  /** Launch `claude` in a session (decision 3): the per-pane header button handler. */
  onLaunchClaude: (session: TerminalSessionInfo) => void;
  /** The single zoomed pane's id, or `null` for the full grid. */
  zoomedId: string | null;
  /** Whether broadcast input is armed (round-2 PR B): every visible pane shows the
   *  LOUD receiving indicator while keystrokes fan out to all of them. Always `false`
   *  once zoomed (the visible set collapses to one → auto-disarm). */
  broadcastArmed: boolean;
  /** The session id of the pane currently under a dragged file (round-2 PR C), or
   *  `null`. The matching pane shows the drop-hint overlay; the hit-test lives in the
   *  view's webview-global drop listener. */
  dropTargetId: string | null;
  /** Rename a session (decision 5). */
  onRename: (id: string, title: string) => void;
  /** Reorder: move `activeId` into `overId`'s slot (drag drop resolution). */
  onReorder: (activeId: string, overId: string) => void;
  /** Toggle a pane's zoom. */
  onToggleZoom: (id: string) => void;
  /** Mark a pane the active one (the ⌘⇧E zoom target). */
  onActivate: (id: string) => void;
}
