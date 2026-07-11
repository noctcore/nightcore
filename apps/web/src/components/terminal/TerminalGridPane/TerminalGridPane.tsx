import '@xterm/xterm/css/xterm.css';

import {
  GripIcon,
  IconButton,
  LockIcon,
  MaximizeIcon,
  MinimizeIcon,
  TerminalIcon,
} from '@/components/ui';
import type { TerminalSessionInfo } from '@/lib/bridge';

import { useInlineRename } from '../terminal-rename';
import {
  displayTitle,
  identityTitle,
  unreadBadge,
  unreadBadgeLabel,
} from '../terminal-shared';
import { useTerminalGridPane } from './TerminalGridPane.hooks';
import type { TerminalGridPaneProps } from './TerminalGridPane.types';

/** The unread-output badge (decision 6c) on a zoomed-away / off-screen grid pane. */
function PaneUnread({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={unreadBadgeLabel(count)}
      className="shrink-0 rounded-full bg-primary/25 px-1.5 text-[10px] font-semibold leading-4 text-primary"
    >
      {unreadBadge(count)}
    </span>
  );
}

/** The renamable pane title (decision 5): single-click activates the pane (the ⌘⇧E
 *  zoom target), double-click inline-edits (Enter save / Esc cancel / blur save). */
function GridPaneTitle({
  session,
  onRename,
  onActivate,
}: {
  session: TerminalSessionInfo;
  onRename: (id: string, title: string) => void;
  onActivate: (id: string) => void;
}) {
  const label = displayTitle(session);
  const rename = useInlineRename(label, (next) => onRename(session.id, next));
  if (rename.editing) {
    return (
      <input
        ref={rename.inputRef}
        aria-label={`Rename ${label}`}
        value={rename.draft}
        onChange={rename.onChange}
        onKeyDown={rename.onKeyDown}
        onBlur={rename.onBlur}
        size={Math.max(rename.draft.length, 6)}
        className="min-w-0 rounded-sm bg-white/10 px-1 text-[11.5px] font-semibold text-foreground outline-none ring-1 ring-primary/60"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => onActivate(session.id)}
      onDoubleClick={rename.begin}
      title={identityTitle(session.confined)}
      className="min-w-0 truncate text-left text-[11.5px] font-semibold text-foreground"
    >
      {label}
    </button>
  );
}

/** One live session's pane inside the grid view (decision 1, PR 2): a header (drag
 *  grip, identity marker, renamable title, unread badge, zoom toggle) over the
 *  session's remount-surviving xterm surface. A thin shell — the attach + @dnd-kit
 *  wiring live in `useTerminalGridPane`. */
export function TerminalGridPane({
  session,
  unread,
  zoomed,
  draggable,
  onRename,
  onToggleZoom,
  onActivate,
}: TerminalGridPaneProps) {
  const v = useTerminalGridPane(session.id, draggable);
  const Identity = session.confined ? LockIcon : TerminalIcon;
  const ZoomIcon = zoomed ? MinimizeIcon : MaximizeIcon;
  const zoomLabel = zoomed ? 'Restore grid (⌘⇧E)' : 'Maximize pane (⌘⇧E)';
  return (
    <div
      ref={v.setRootRef}
      data-session-id={session.id}
      className={`group flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-[#0a0a0f] transition-colors ${
        v.isOver ? 'border-primary/70' : 'border-border'
      } ${v.isDragging ? 'opacity-40' : ''}`}
    >
      <div className="flex items-center gap-1.5 border-b border-border bg-black/25 px-2 py-1">
        {draggable && (
          <button
            type="button"
            aria-label={`Reorder ${displayTitle(session)}`}
            title="Drag to reorder"
            className="shrink-0 cursor-grab rounded p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 active:cursor-grabbing"
            {...v.gripAttributes}
            {...v.gripListeners}
          >
            <GripIcon size={13} />
          </button>
        )}
        <Identity
          size={12}
          className={`shrink-0 ${session.confined ? 'text-warning' : 'text-primary/80'}`}
          aria-hidden
        />
        <GridPaneTitle session={session} onRename={onRename} onActivate={onActivate} />
        <PaneUnread count={unread} />
        <IconButton
          label={zoomLabel}
          onClick={() => onToggleZoom(session.id)}
          className="ml-auto shrink-0"
        >
          <ZoomIcon size={13} />
        </IconButton>
      </div>
      <div ref={v.containerRef} className="min-h-0 flex-1 overflow-hidden p-1.5" />
    </div>
  );
}
