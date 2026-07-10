import {
  CloseIcon,
  HistoryIcon,
  IconButton,
  LockIcon,
  PlusIcon,
  TerminalIcon,
} from '@/components/ui';
import type { PersistedTerminalInfo, TerminalSessionInfo } from '@/lib/bridge';

import { identityTitle, restoredIdentityTitle, terminalLabel } from '../terminal-shared';
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

function Tab({
  session,
  active,
  onSelect,
  onClose,
}: {
  session: TerminalSessionInfo;
  active: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const label = terminalLabel(session.cwd);
  return (
    <div
      className={`group flex items-center gap-1.5 rounded-t-[8px] border-b-2 px-2.5 py-1.5 transition-colors ${
        active
          ? 'border-primary bg-white/[0.05] text-foreground'
          : 'border-transparent text-muted-foreground hover:bg-white/[0.03] hover:text-foreground'
      }`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title={identityTitle(session.confined)}
        onClick={() => onSelect(session.id)}
        className="flex min-w-0 items-center gap-1.5"
      >
        <IdentityDot confined={session.confined} />
        <span className="max-w-[12rem] truncate text-[12.5px] font-medium">{label}</span>
      </button>
      <IconButton
        label={`Close ${label}`}
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
 *  dismisses it (deletes the persisted file). */
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
  const label = terminalLabel(info.cwd);
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

/** The terminal tabs bar: one tab per live session with a per-tab identity marker
 *  and close affordance, then any restored (read-only) tabs from a prior run, plus
 *  a "+" that opens the new-terminal picker (disabled at the 8-session cap). Purely
 *  presentational — the parent owns state + actions. */
export function TerminalTabs({
  sessions,
  restored,
  activeId,
  onSelect,
  onClose,
  onDismiss,
  onNewTab,
  canAddTab,
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
          onSelect={onSelect}
          onClose={onClose}
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
        className="my-0.5 flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <PlusIcon size={14} />
      </button>
    </div>
  );
}
