import {
  BellIcon,
  BoltIcon,
  BroadcastIcon,
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
import { rovingKeydown } from '@/lib/roving-keydown';

import {
  attentionLevel,
  IDLE_ATTENTION,
  type TerminalAttention,
} from '../terminal-attention';
import type { TerminalViewMode } from '../terminal-layout';
import { formatShortcut } from '../terminal-platform';
import { useInlineRename } from '../terminal-rename';
import {
  attentionBadgeLabel,
  broadcastToggleLabel,
  broadcastToggleTitle,
  displayTitle,
  identityTitle,
  restoredIdentityTitle,
  ungovernedLabel,
  ungovernedTitle,
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

/** The 3-state attention badge (T11) on an inactive tab: nothing when idle; a muted
 *  count pill for has-output (generic byte-activity, not content parsing); and a LOUD
 *  pulsing warning dot for needs-attention (an OSC/BEL completion fired while the tab
 *  was off-screen). Hidden on the active tab (its state clears on activation). */
function AttentionBadge({ attention }: { attention: TerminalAttention }) {
  const level = attentionLevel(attention);
  if (level === 'idle') return null;
  if (level === 'needs-attention') {
    return (
      <span
        aria-label={attentionBadgeLabel()}
        title={attentionBadgeLabel()}
        className="flex shrink-0 items-center rounded-full bg-warning/20 px-1.5 py-1 ring-1 ring-warning/50"
      >
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
      </span>
    );
  }
  return (
    <span
      aria-label={unreadBadgeLabel(attention.unread)}
      className="shrink-0 rounded-full bg-primary/25 px-1.5 text-3xs font-semibold leading-4 text-primary"
    >
      {unreadBadge(attention.unread)}
    </span>
  );
}

/** The "ungoverned session" marker (decision 3): a warning bolt on a task-linked or
 *  Claude-launched tab, with the verbatim governance tooltip. Mirrors the pane's own
 *  inline marker (the feature keeps these tiny presentational glyphs per-component,
 *  like `IdentityDot`). */
function UngovernedMarker({ size = 11 }: { size?: number }) {
  return (
    <span
      title={ungovernedTitle()}
      aria-label={ungovernedLabel()}
      className="flex shrink-0 items-center text-warning"
    >
      <BoltIcon size={size} aria-hidden />
    </span>
  );
}

function Tab({
  session,
  active,
  attention,
  ungoverned,
  onSelect,
  onClose,
  onRename,
}: {
  session: TerminalSessionInfo;
  active: boolean;
  attention: TerminalAttention;
  ungoverned: boolean;
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
            className="min-w-0 rounded-sm bg-white/10 px-1 text-xs-plus font-medium text-foreground outline-none ring-1 ring-primary/60"
          />
        </span>
      ) : (
        <button
          type="button"
          role="tab"
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          title={identityTitle(session.confined)}
          onClick={() => onSelect(session.id)}
          onDoubleClick={rename.begin}
          onKeyDown={rovingKeydown}
          className="flex min-w-0 items-center gap-1.5"
        >
          <IdentityDot confined={session.confined} />
          <span className="max-w-[12rem] truncate text-xs-plus font-medium">{label}</span>
        </button>
      )}
      {ungoverned && <UngovernedMarker />}
      {!active && <AttentionBadge attention={attention} />}
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
        tabIndex={active ? 0 : -1}
        title={restoredIdentityTitle()}
        onClick={() => onSelect(info.id)}
        onKeyDown={rovingKeydown}
        className="flex min-w-0 items-center gap-1.5"
      >
        <HistoryIcon size={12} className="shrink-0 opacity-70" aria-hidden />
        <span className="max-w-[12rem] truncate text-xs-plus font-medium italic">{label}</span>
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
      className="my-0.5 flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-2xs font-medium text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
    >
      {toGrid ? <GridIcon size={13} aria-hidden /> : <TabsIcon size={13} aria-hidden />}
      <span>{label}</span>
      {!toGrid && <Kbd>{formatShortcut('E', { shift: true })}</Kbd>}
    </button>
  );
}

/** The broadcast-input toggle (round-2 PR B, § B.3): a grid-only control that arms
 *  "type once, run everywhere" — every keystroke fans out to every visible pane. LOUD
 *  when armed (amber fill + ring + a pulsing dot) since broadcasting to N shells is a
 *  footgun; disabled (with an explanatory title) until there are 2+ visible panes. */
function BroadcastToggle({
  armed,
  eligible,
  onToggle,
}: {
  armed: boolean;
  eligible: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={broadcastToggleLabel(armed)}
      aria-pressed={armed}
      title={broadcastToggleTitle(armed, eligible)}
      disabled={!eligible && !armed}
      onClick={onToggle}
      className={`my-0.5 flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-2xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        armed
          ? 'bg-amber-400/20 text-amber-300 ring-1 ring-amber-400/70'
          : 'text-muted-foreground hover:bg-white/[0.08] hover:text-foreground'
      }`}
    >
      <BroadcastIcon size={13} aria-hidden />
      <span>{armed ? 'Broadcasting' : 'Broadcast'}</span>
      {armed && (
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
      )}
    </button>
  );
}

/** The "jump to next waiting terminal" affordance (T11): shown in the toolbar only
 *  when one or more sessions are in the needs-attention state. LOUD (warning fill +
 *  a pulsing bell) so a backgrounded terminal that finished/asked is never missed;
 *  clicking cycles to the next waiting session and selects it. */
function JumpAttentionButton({ count, onJump }: { count: number; onJump: () => void }) {
  const label = `Jump to the next of ${count} waiting terminal${count === 1 ? '' : 's'}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onJump}
      className="my-0.5 flex shrink-0 items-center gap-1.5 rounded-md bg-warning/15 px-2 py-1 text-2xs font-semibold text-warning ring-1 ring-warning/40 transition-colors hover:bg-warning/25"
    >
      <span
        aria-hidden
        className="flex animate-[nc-pulse_1.4s_ease-in-out_infinite] items-center"
      >
        <BellIcon size={13} />
      </span>
      <span>{count}</span>
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
  attention,
  viewMode,
  onToggleViewMode,
  broadcastArmed,
  broadcastEligible,
  onToggleBroadcast,
  attentionWaiting,
  onJumpAttention,
  ungovernedIds,
  headerSlot,
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
          attention={attention[session.id] ?? IDLE_ATTENTION}
          ungoverned={ungovernedIds.has(session.id)}
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
      {headerSlot}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {attentionWaiting > 0 && (
          <JumpAttentionButton count={attentionWaiting} onJump={onJumpAttention} />
        )}
        {viewMode === 'grid' && (
          <BroadcastToggle
            armed={broadcastArmed}
            eligible={broadcastEligible}
            onToggle={onToggleBroadcast}
          />
        )}
        <ViewModeToggle viewMode={viewMode} onToggleViewMode={onToggleViewMode} />
      </div>
    </div>
  );
}
