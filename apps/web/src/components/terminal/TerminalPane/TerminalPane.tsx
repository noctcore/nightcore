import '@xterm/xterm/css/xterm.css';

import { LockIcon, TerminalIcon } from '@/components/ui';

import { identityLabel, identityTitle } from '../terminal-shared';
import { useTerminalPane } from './TerminalPane.hooks';
import type { TerminalPaneProps } from './TerminalPane.types';

/** The identity chrome header (decision 1): the user terminal runs OUTSIDE the
 *  agent guardrails, so the pane says so — an unconfined marker (or the confined
 *  variant for PR C), the shell, and the cwd. */
function IdentityHeader({ confined, shell, cwd }: { confined: boolean; shell: string; cwd: string }) {
  const Icon = confined ? LockIcon : TerminalIcon;
  return (
    <div
      title={identityTitle(confined)}
      className="flex items-center gap-2 border-b border-border bg-black/25 px-3 py-1.5 text-[11px]"
    >
      <span
        className={`flex items-center gap-1.5 font-medium ${
          confined ? 'text-warning' : 'text-primary/90'
        }`}
      >
        <Icon size={12} aria-hidden />
        {identityLabel(confined)}
      </span>
      <span className="text-muted-foreground/50" aria-hidden>
        ·
      </span>
      <span className="truncate font-mono text-muted-foreground">{shell}</span>
      <span className="truncate font-mono text-muted-foreground/70">{cwd}</span>
    </div>
  );
}

/** The xterm host pane for one session: the identity chrome plus the terminal
 *  surface the session's (remount-surviving) xterm instance is attached into. A
 *  thin shell — the ref + attach effect live in `useTerminalPane`. */
export function TerminalPane({ session }: TerminalPaneProps) {
  const { containerRef } = useTerminalPane(session);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0a0a0f]">
      <IdentityHeader confined={session.confined} shell={session.shell} cwd={session.cwd} />
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden p-1.5" />
    </div>
  );
}
