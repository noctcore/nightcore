import { CloseIcon, IconButton, LockIcon, PlusIcon, TerminalIcon } from '@/components/ui';
import type { TerminalSessionInfo } from '@/lib/bridge';

import { identityTitle, terminalLabel } from '../terminal-shared';
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

/** The terminal tabs bar: one tab per live session with a per-tab identity marker
 *  and close affordance, plus a "+" that opens the new-terminal picker (disabled at
 *  the 8-session cap). Purely presentational — the parent owns state + actions. */
export function TerminalTabs({
  sessions,
  activeId,
  onSelect,
  onClose,
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
