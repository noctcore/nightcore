import {
  BoltIcon,
  CloseIcon,
  HistoryIcon,
  IconButton,
  Kbd,
  LockIcon,
  PlusIcon,
  TerminalIcon,
} from '@/components/ui';
import type { PersistedTerminalInfo, TerminalSessionInfo } from '@/lib/bridge';
import { rovingKeydown } from '@/lib/roving-keydown';

import {
  attentionLevel,
  IDLE_ATTENTION,
  type TerminalAttention,
} from '../terminal-attention';
import { formatShortcut } from '../terminal-platform';
import { useInlineRename } from '../terminal-rename';
import {
  attentionBadgeLabel,
  displayTitle,
  identityTitle,
  restoredIdentityTitle,
  ungovernedLabel,
  ungovernedTitle,
  unreadBadge,
  unreadBadgeLabel,
} from '../terminal-shared';
import { branchForCwd, newTabTitle, useActiveTabVisible } from './TerminalTabs.hooks';
import {
  BroadcastToggle,
  JumpAttentionButton,
  ViewModeToggle,
} from './TerminalTabs.parts';
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

/** The cmux-style branch chip (#405): the git branch a tab's shell is sitting on, when
 *  its cwd is a known worktree. Rendered as a separate, dimmer token AFTER the title so
 *  it reads as metadata rather than part of the name — and so it never lands inside the
 *  title's own accessible text. Absent (not blank) for the repo root or a browsed
 *  folder, where there is no branch to claim. */
function BranchChip({ branch }: { branch: string }) {
  return (
    <span
      title={`On branch ${branch}`}
      className="max-w-[7rem] shrink-0 truncate rounded bg-white/[0.06] px-1 font-mono text-3xs text-muted-foreground/80"
    >
      {branch}
    </span>
  );
}

function Tab({
  session,
  active,
  attention,
  ungoverned,
  branch,
  onSelect,
  onClose,
  onRename,
}: {
  session: TerminalSessionInfo;
  active: boolean;
  attention: TerminalAttention;
  ungoverned: boolean;
  branch: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const label = displayTitle(session);
  const rename = useInlineRename(label, (next) => onRename(session.id, next));
  return (
    <div
      data-tab-id={session.id}
      className={`group flex shrink-0 items-center gap-1.5 rounded-t-[8px] border-b-2 px-2.5 py-1.5 transition-colors ${
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
      {branch !== null && <BranchChip branch={branch} />}
      {ungoverned && <UngovernedMarker />}
      {!active && <AttentionBadge attention={attention} />}
      <IconButton
        label={active ? `Close ${label} (${formatShortcut('W')})` : `Close ${label}`}
        onClick={() => onClose(session.id)}
        className="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
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
      data-tab-id={info.id}
      className={`group flex shrink-0 items-center gap-1.5 rounded-t-[8px] border-b-2 px-2.5 py-1.5 transition-colors ${
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
      {/* #405: the marker is persisted server-side, so it rides the restore too — the
          shell ending is not a reason to stop saying an agent ran in it. */}
      {info.ungoverned && <UngovernedMarker />}
      <IconButton
        label={`Dismiss ${label}`}
        onClick={() => onDismiss(info.id)}
        className="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <CloseIcon size={12} />
      </IconButton>
    </div>
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
  worktrees,
  headerSlot,
}: TerminalTabsProps) {
  const stripRef = useActiveTabVisible(activeId);
  return (
    <div
      role="tablist"
      aria-label="Terminal sessions"
      className="flex items-center gap-1 border-b border-border bg-black/20 px-2 pt-1"
    >
      {/* Overflow (#405): the strip scrolls instead of squeezing. At the 12-session cap
          the tabs used to compress the right-hand toolbar off the bar entirely, and
          `shrink-0` on each tab means they now keep their size and the strip pans.
          The scrollbar is hidden — a visible one on a 30px-tall tab bar is chrome, and
          `useActiveTabVisible` + ⌘1..9 cover reaching an off-screen tab. */}
      <div
        ref={stripRef}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {sessions.map((session) => (
          <Tab
            key={session.id}
            session={session}
            active={session.id === activeId}
            attention={attention[session.id] ?? IDLE_ATTENTION}
            ungoverned={ungovernedIds.has(session.id)}
            branch={branchForCwd(worktrees, session.cwd)}
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
      </div>
      <div className="flex shrink-0 items-center gap-1">
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
