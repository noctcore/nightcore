import '@xterm/xterm/css/xterm.css';

import {
  BoltIcon,
  CloseIcon,
  IconButton,
  LockIcon,
  ProviderIcon,
  TagIcon,
  TerminalIcon,
} from '@/components/ui';
import type { TerminalSessionInfo } from '@/lib/bridge';

import { useInlineRename } from '../terminal-rename';
import {
  confinedNoiseHint,
  displayPath,
  displayTitle,
  identityLabel,
  identityTitle,
  linkedTaskChipLabel,
  ungovernedLabel,
  ungovernedTitle,
} from '../terminal-shared';
import { TerminalDropHint } from '../TerminalDropHint';
import { TerminalSearchBar } from '../TerminalSearchBar';
import { useTerminalPane } from './TerminalPane.hooks';
import type { TerminalPaneLink, TerminalPaneProps } from './TerminalPane.types';

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

/** The task-link + governance chrome row (cockpit spec PR 4, decisions 2 & 3): the
 *  "ungoverned" marker, the linked-task chip with a clear affordance, and the one-click
 *  Claude launch (POSIX shells only). Rendered only when there is something to show. */
function LinkChrome({ link }: { link: TerminalPaneLink }) {
  if (!link.ungoverned && link.linkedTitle === null && !link.canLaunchClaude) return null;
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {link.ungoverned && (
        <span
          title={ungovernedTitle()}
          aria-label={ungovernedLabel()}
          className="flex items-center gap-1 font-medium text-warning"
        >
          <BoltIcon size={12} aria-hidden />
          {ungovernedLabel()}
        </span>
      )}
      {link.linkedTitle !== null && (
        <span className="flex items-center gap-1 rounded bg-white/[0.06] px-1.5 py-0.5 text-muted-foreground">
          <TagIcon size={11} aria-hidden />
          <span className="max-w-[16rem] truncate">{linkedTaskChipLabel(link.linkedTitle)}</span>
          <IconButton label="Clear task link" onClick={link.onClearLink} className="shrink-0">
            <CloseIcon size={10} />
          </IconButton>
        </span>
      )}
      {link.canLaunchClaude && (
        <button
          type="button"
          onClick={link.onLaunchClaude}
          title="Type `claude` into this terminal (runs as you, outside the gates)"
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 font-medium text-primary/90 transition-colors hover:bg-primary/10 hover:text-primary"
        >
          <ProviderIcon provider="claude" size={12} />
          Launch Claude
        </button>
      )}
    </div>
  );
}

/** The identity chrome header (decision 1): the user terminal runs OUTSIDE the
 *  agent guardrails, so the pane says so — the (renamable) session title, an
 *  unconfined marker (or the confined variant), the shell, and the cwd. A confined
 *  pane also gets a one-line hint that $HOME write denials during shell startup are
 *  expected. The task-link / Claude-launch chrome (decisions 2 & 3) rides below it. */
function IdentityHeader({
  session,
  onRename,
  link,
}: {
  session: TerminalSessionInfo;
  onRename: (id: string, title: string) => void;
  link: TerminalPaneLink;
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
      <LinkChrome link={link} />
    </div>
  );
}

/** The xterm host pane for one session: the identity chrome plus the terminal
 *  surface the session's (remount-surviving) xterm instance is attached into. A
 *  thin shell — the ref + attach effect live in `useTerminalPane`. */
export function TerminalPane({ session, isDropTarget, onRename, link }: TerminalPaneProps) {
  const { containerRef, search } = useTerminalPane(session);
  return (
    <div data-session-id={session.id} className="flex min-h-0 flex-1 flex-col bg-background">
      <IdentityHeader session={session} onRename={onRename} link={link} />
      <div ref={search.rootRef} className="relative min-h-0 flex-1">
        <div ref={containerRef} className="h-full overflow-hidden p-1.5" />
        {isDropTarget && <TerminalDropHint />}
        {search.open && (
          <div className="absolute right-3 top-2 z-10">
            <TerminalSearchBar
              query={search.query}
              noMatch={search.noMatch}
              onQueryChange={search.onQueryChange}
              onNext={search.next}
              onPrev={search.prev}
              onClose={search.close}
            />
          </div>
        )}
      </div>
    </div>
  );
}
