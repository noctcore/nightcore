import '@xterm/xterm/css/xterm.css';

import { LockIcon, TerminalIcon } from '@/components/ui';
import type { TerminalSessionInfo } from '@/lib/bridge';

import { useInlineRename } from '../terminal-rename';
import {
  confinedNoiseHint,
  displayPath,
  displayTitle,
  identityLabel,
  identityTitle,
} from '../terminal-shared';
import { useTerminalPane } from './TerminalPane.hooks';
import type { TerminalPaneProps } from './TerminalPane.types';

/** The renamable session title (decision 5): double-click to inline-edit, Enter
 *  saves / Esc cancels / blur saves. Shows the manual name or the cwd-leaf
 *  fallback. Its own edit state lives in the shared `useInlineRename` hook. */
function PaneTitle({
  session,
  onRename,
}: {
  session: TerminalSessionInfo;
  onRename: (id: string, title: string) => void;
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
        className="rounded-sm bg-white/10 px-1 text-[12px] font-semibold text-foreground outline-none ring-1 ring-primary/60"
      />
    );
  }
  return (
    <button
      type="button"
      onDoubleClick={rename.begin}
      title="Double-click to rename"
      className="max-w-[24rem] truncate text-left text-[12px] font-semibold text-foreground"
    >
      {label}
    </button>
  );
}

/** The identity chrome header (decision 1): the user terminal runs OUTSIDE the
 *  agent guardrails, so the pane says so — the (renamable) session title, an
 *  unconfined marker (or the confined variant), the shell, and the cwd. A confined
 *  pane also gets a one-line hint that $HOME write denials during shell startup are
 *  expected. */
function IdentityHeader({
  session,
  onRename,
}: {
  session: TerminalSessionInfo;
  onRename: (id: string, title: string) => void;
}) {
  const { confined, shell, cwd } = session;
  const Icon = confined ? LockIcon : TerminalIcon;
  return (
    <div className="flex flex-col gap-0.5 border-b border-border bg-black/25 px-3 py-1.5">
      <PaneTitle session={session} onRename={onRename} />
      <div title={identityTitle(confined)} className="flex items-center gap-2 text-[11px]">
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
        <span className="truncate font-mono text-muted-foreground/70">{displayPath(cwd)}</span>
      </div>
      {confined && (
        <span className="mt-0.5 text-[10px] text-muted-foreground/70">{confinedNoiseHint()}</span>
      )}
    </div>
  );
}

/** The xterm host pane for one session: the identity chrome plus the terminal
 *  surface the session's (remount-surviving) xterm instance is attached into. A
 *  thin shell — the ref + attach effect live in `useTerminalPane`. */
export function TerminalPane({ session, onRename }: TerminalPaneProps) {
  const { containerRef } = useTerminalPane(session);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0a0a0f]">
      <IdentityHeader session={session} onRename={onRename} />
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden p-1.5" />
    </div>
  );
}
