/** Props for the {@link TerminalGrid} — the grid view mode (decision 1, PR 2). */
import type { TerminalSessionInfo } from '@/lib/bridge';

/** Props for the grid view. Presentational over the shared session manager: the
 *  parent (the Terminal view) owns the ordered session list, the zoom + reorder
 *  state, and the rename/activate actions. */
export interface TerminalGridProps {
  /** The live sessions, already in the persisted display order. */
  sessions: TerminalSessionInfo[];
  /** Per-session unread-output counts (decision 6c). Missing ids read as 0. */
  unread: Readonly<Record<string, number>>;
  /** Session ids marked "ungoverned" (decision 3) — a warning marker per pane. */
  ungovernedIds: ReadonlySet<string>;
  /** The single zoomed pane's id, or `null` for the full grid. */
  zoomedId: string | null;
  /** Rename a session (decision 5). */
  onRename: (id: string, title: string) => void;
  /** Reorder: move `activeId` into `overId`'s slot (drag drop resolution). */
  onReorder: (activeId: string, overId: string) => void;
  /** Toggle a pane's zoom. */
  onToggleZoom: (id: string) => void;
  /** Mark a pane the active one (the ⌘⇧E zoom target). */
  onActivate: (id: string) => void;
}
