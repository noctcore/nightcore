import { closestCenter, DndContext, DragOverlay } from '@dnd-kit/core';

import { LockIcon, TerminalIcon } from '@/components/ui';
import type { TerminalSessionInfo } from '@/lib/bridge';

import { IDLE_ATTENTION } from '../terminal-attention';
import { displayTitle, gridColumns } from '../terminal-shared';
import { TerminalGridPane } from '../TerminalGridPane';
import { useTerminalGrid } from './TerminalGrid.hooks';
import type { TerminalGridProps } from './TerminalGrid.types';

/** The `<DragOverlay>` preview: a lightweight header clone of the dragged pane (NOT
 *  the live xterm — there is only one instance per session, and moving/scaling its
 *  host mid-drag would corrupt the fit). */
function GridPanePreview({ session }: { session: TerminalSessionInfo }) {
  const Identity = session.confined ? LockIcon : TerminalIcon;
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-primary/70 bg-popover px-3 py-2 shadow-lg">
      <Identity
        size={12}
        className={session.confined ? 'text-warning' : 'text-primary/80'}
        aria-hidden
      />
      <span className="text-2xs-plus font-semibold text-foreground">{displayTitle(session)}</span>
    </div>
  );
}

/** The grid view mode (decision 1, PR 2): every live session's pane at once, as a
 *  FLAT CSS grid of siblings keyed by session id — so React never re-parents a pane
 *  during reorder/relayout (which would tear the persistent xterm host between
 *  parents mid-drag). Columns follow the session count (rows follow); a `<DndContext>`
 *  gives pointer + keyboard reorder; a zoomed pane replaces the grid while the others
 *  stay alive in the session manager (still buffering + badging). A thin shell — the
 *  DnD state + refit scheduling live in `useTerminalGrid`. */
export function TerminalGrid({
  sessions,
  attention,
  ungovernedIds,
  canLaunchClaude,
  zoomedId,
  broadcastArmed,
  dropTargetId,
  onRename,
  onLaunchClaude,
  onReorder,
  onToggleZoom,
  onActivate,
}: TerminalGridProps) {
  const g = useTerminalGrid({ sessions, zoomedId, onReorder });
  const zoomed = zoomedId !== null ? (sessions.find((s) => s.id === zoomedId) ?? null) : null;
  const visible = zoomed !== null ? [zoomed] : sessions;
  const columns = zoomed !== null ? 1 : gridColumns(sessions.length);
  const rows = zoomed !== null ? 1 : Math.max(1, Math.ceil(sessions.length / columns));
  return (
    <DndContext
      sensors={g.sensors}
      collisionDetection={closestCenter}
      onDragStart={g.onDragStart}
      onDragEnd={g.onDragEnd}
      onDragCancel={g.onDragCancel}
    >
      <div
        className="grid min-h-0 flex-1 gap-2 p-2"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        }}
      >
        {visible.map((session) => (
          <TerminalGridPane
            key={session.id}
            session={session}
            attention={attention[session.id] ?? IDLE_ATTENTION}
            ungoverned={ungovernedIds.has(session.id)}
            canLaunch={canLaunchClaude(session)}
            zoomed={zoomedId === session.id}
            draggable={zoomedId === null}
            broadcasting={broadcastArmed}
            isDropTarget={dropTargetId === session.id}
            onRename={onRename}
            onLaunchClaude={() => onLaunchClaude(session)}
            onToggleZoom={onToggleZoom}
            onActivate={onActivate}
          />
        ))}
      </div>
      <DragOverlay>
        {g.activeSession !== null ? <GridPanePreview session={g.activeSession} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
