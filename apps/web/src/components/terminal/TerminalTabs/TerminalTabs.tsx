import {
  CloseIcon,
  GridIcon,
  HistoryIcon,
  IconButton,
  Kbd,
  LockIcon,
  PlusIcon,
  TabsIcon,
  TerminalIcon,
} from '@/components/ui';
import type { PersistedTerminalInfo, TerminalSessionInfo } from '@/lib/bridge';

import type { TerminalViewMode } from '../terminal-layout';
import { formatShortcut } from '../terminal-platform';
import { useInlineRename } from '../terminal-rename';
import {
  displayTitle,
  identityTitle,
  restoredIdentityTitle,
  unreadBadge,
  unreadBadgeLabel,
} from '../terminal-shared';
import { newTabTitle } from './TerminalTabs.hooks';
import type { TerminalTabsProps } from './TerminalTabs.types';

/** The per-tab identity marker (decision 1): unconfined tabs carry a terminal
 *  glyph, confined tabs a distinct lock. In PR B every session is unconfined; the
 *  confined variant renders straight from `session.confined` for PR C. */
function IdentityDot({ confined }: { confined: boolean }) {
  const Icon = confined ? LockIcon : TerminalIcon;
  return (
    <Icon
      size={12}
      className={`shrink-0 ${confined ? 'text-warning' : 'text-primary/80'}`}
      aria-hidden
    />
  );
}

/** The unread-output badge (decision 6c): a small pill on an inactive tab when
 *  output has arrived while it wasn't visible. Generic byte-activity, not content
 *  parsing. Hidden on the active tab (its badge is cleared on activation). */
function UnreadBadge({ count }: { count: number }) {
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

function Tab({
  session,
  active,
  unread,
  onSelect,
  onClose,
  onRename,
}: {
  session: TerminalSessionInfo;
  active: boolean;
  unread: number;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const label = displayTitle(session);
  const rename = useInlineRename(label, (next) => onRename(session.id, next));
  return (
    <div
      className={`group flex items-center gap-1.5 rounded-t-[8px] border-b-2 px-2.5 py-1.5 transition-colors ${
        active
          ? 'border-primary bg-white/[0.05] text-foreground'
          : 'border-transparent text-muted-foreground hover:bg-white/[0.03] hover:text-foreground'
      }`}
    >
      {rename.editing ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <IdentityDot confined={session.confined} />
          <input
            ref={rename.inputRef}
            aria-label={`Rename ${label}`}
            value={rename.draft}
            onChange={rename.onChange}
            onKeyDown={rename.onKeyDown}
            onBlur={rename.onBlur}
            size={Math.max(rename.draft.length, 4)}
            className="min-w-0 rounded-sm bg-white/10 px-1 text-[12.5px] font-medium text-foreground outline-none ring-1 ring-primary/60"
          />
        </span>
      ) : (
        <button
          type="button"
          role="tab"
          aria-selected={active}
          title={identityTitle(session.confined)}
          onClick={() => onSelect(session.id)}
          onDoubleClick={rename.begin}
          className="flex min-w-0 items-center gap-1.5"
        >
          <IdentityDot confined={session.confined} />
          <span className="max-w-[12rem] truncate text-[12.5px] font-medium">{label}</span>
        </button>
      )}
      {!active && <UnreadBadge count={unread} />}
      <IconButton
        label={active ? `Close ${label} (${formatShortcut('W')})` : `Close ${label}`}
        onClick={() => onClose(session.id)}
        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
      >
        <CloseIcon size={12} />
      </IconButton>
    </div>
  );
}

/** A restored (read-only) tab: a dimmed, history-marked tab for a dead session from
 *  a prior run. Selecting it replays its persisted scrollback read-only; the X
 *  dismisses it (deletes the persisted file). It shows the name it had while live
 *  (decision 5) but is not renamable — the shell is gone. */
function RestoredTab({
  info,
  active,
  onSelect,
  onDismiss,
}: {
  info: PersistedTerminalInfo;
  active: boolean;
  onSelect: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const label = displayTitle(info);
  return (
    <div
      className={`group flex items-center gap-1.5 rounded-t-[8px] border-b-2 px-2.5 py-1.5 transition-colors ${
        active
          ? 'border-muted-foreground/60 bg-white/[0.04] text-muted-foreground'
          : 'border-transparent text-muted-foreground/60 hover:bg-white/[0.02] hover:text-muted-foreground'
      }`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title={restoredIdentityTitle()}
        onClick={() => onSelect(info.id)}
        className="flex min-w-0 items-center gap-1.5"
      >
        <HistoryIcon size={12} className="shrink-0 opacity-70" aria-hidden />
        <span className="max-w-[12rem] truncate text-[12.5px] font-medium italic">{label}</span>
      </button>
      <IconButton
        label={`Dismiss ${label}`}
        onClick={() => onDismiss(info.id)}
        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
      >
        <CloseIcon size={12} />
      </IconButton>
    </div>
  );
}

/** The tabs⇄grid view-mode toggle (decision 1, PR 2): a single button that flips to
 *  the OTHER mode, showing the target mode's glyph + a ⌘⇧E hint (the zoom shortcut
 *  lives in grid mode). Pinned to the right of the tab strip. */
function ViewModeToggle({
  viewMode,
  onToggleViewMode,
}: {
  viewMode: TerminalViewMode;
  onToggleViewMode: () => void;
}) {
  const toGrid = viewMode === 'tabs';
  const label = toGrid ? 'Grid view' : 'Tabs view';
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={!toGrid}
      title={`${label}${toGrid ? ' — arrange every terminal at once' : ''}`}
      onClick={onToggleViewMode}
      className="my-0.5 ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
    >
      {toGrid ? <GridIcon size={13} aria-hidden /> : <TabsIcon size={13} aria-hidden />}
      <span>{label}</span>
      {!toGrid && <Kbd>{formatShortcut('E', { shift: true })}</Kbd>}
    </button>
  );
}

/** The terminal tabs bar: one tab per live session with a per-tab identity marker,
 *  an unread-output badge, an inline-rename (double-click) title, and a close
 *  affordance, then any restored (read-only) tabs from a prior run, a "+" that opens
 *  the new-terminal picker (disabled at the session cap), and the tabs⇄grid view-mode
 *  toggle pinned right. Purely presentational — the parent owns state + actions. */
export function TerminalTabs({
  sessions,
  restored,
  activeId,
  onSelect,
  onClose,
  onDismiss,
  onNewTab,
  canAddTab,
  onRename,
  unread,
  viewMode,
  onToggleViewMode,
}: TerminalTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Terminal sessions"
      className="flex items-center gap-1 border-b border-border bg-black/20 px-2 pt-1"
    >
      {sessions.map((session) => (
        <Tab
          key={session.id}
          session={session}
          active={session.id === activeId}
          unread={unread[session.id] ?? 0}
          onSelect={onSelect}
          onClose={onClose}
          onRename={onRename}
        />
      ))}
      {restored.map((info) => (
        <RestoredTab
          key={info.id}
          info={info}
          active={info.id === activeId}
          onSelect={onSelect}
          onDismiss={onDismiss}
        />
      ))}
      <button
        type="button"
        aria-label={newTabTitle(canAddTab)}
        title={newTabTitle(canAddTab)}
        disabled={!canAddTab}
        onClick={onNewTab}
        className="my-0.5 flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <PlusIcon size={14} />
        {canAddTab && <Kbd>{formatShortcut('T')}</Kbd>}
      </button>
      <ViewModeToggle viewMode={viewMode} onToggleViewMode={onToggleViewMode} />
    </div>
  );
}
