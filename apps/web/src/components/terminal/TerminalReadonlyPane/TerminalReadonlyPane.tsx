import '@xterm/xterm/css/xterm.css';

import { BoltIcon, Button, HistoryIcon, PlayIcon, ProviderIcon, SearchIcon } from '@/components/ui';

import {
  displayPath,
  restoredIdentityLabel,
  restoredIdentityTitle,
  ungovernedLabel,
  ungovernedTitle,
} from '../terminal-shared';
import { TerminalSearchBar } from '../TerminalSearchBar';
import { useTerminalReadonlyPane } from './TerminalReadonlyPane.hooks';
import type { TerminalReadonlyPaneProps } from './TerminalReadonlyPane.types';

/** The restored-session chrome: a dimmed "session ended — read-only" marker plus
 *  the shell + cwd, matching the live pane's identity header layout. */
function RestoredHeader({
  shell,
  cwd,
  ungoverned,
}: {
  shell: string;
  cwd: string;
  ungoverned: boolean;
}) {
  return (
    <div
      title={restoredIdentityTitle()}
      className="flex items-center gap-2 border-b border-border bg-black/25 px-3 py-1.5 text-2xs"
    >
      <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
        <HistoryIcon size={12} aria-hidden />
        {restoredIdentityLabel()}
      </span>
      <span className="text-muted-foreground/50" aria-hidden>
        ·
      </span>
      <span className="truncate font-mono text-muted-foreground/70">{shell}</span>
      <span className="truncate font-mono text-muted-foreground/50">{displayPath(cwd)}</span>
      {/* #405: the persisted marker outlives the shell, so a restored tab still says an
          agent ran here — the record does not soften just because the process ended. */}
      {ungoverned && (
        <span
          title={ungovernedTitle()}
          aria-label={ungovernedLabel()}
          className="flex shrink-0 items-center gap-1 text-warning"
        >
          <BoltIcon size={11} aria-hidden />
          {ungovernedLabel()}
        </span>
      )}
    </div>
  );
}

/** A restored (dead) session replayed READ-ONLY (decision 3): its persisted
 *  scrollback in an input-disabled xterm, under a chrome that says the shell ended,
 *  with a "start a fresh shell here" action (disabled — with a hint — when the
 *  original folder is gone). A thin shell; the replay lives in the hook. */
export function TerminalReadonlyPane({
  info,
  canRestore,
  onRestore,
  onResumeClaude,
}: TerminalReadonlyPaneProps) {
  const v = useTerminalReadonlyPane(info.id);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <RestoredHeader shell={info.shell} cwd={info.cwd} ungoverned={info.ungoverned} />
      <div className="flex items-center gap-3 border-b border-border/60 bg-warning/[0.06] px-3 py-2">
        <span className="min-w-0 flex-1 text-xs-flat text-muted-foreground">
          {canRestore
            ? 'This session ended. Start a fresh shell to continue in the same folder.'
            : 'This session ended, and its original folder is no longer available.'}
        </span>
        {/* #405: a restored tab is usually opened to FIND something in it. The live
            pane's ⌘F is discoverable once you have clicked into the terminal; a
            read-only replay is not focusable the same way, so it gets a real button. */}
        <Button
          variant="secondary"
          onClick={v.search.openBar}
          className="!py-1 text-xs-flat"
          title="Search this session's scrollback (⌘F)"
        >
          <SearchIcon size={13} />
          Search
        </Button>
        <Button
          variant="secondary"
          onClick={onResumeClaude}
          disabled={!canRestore}
          className="!py-1 text-xs-flat"
          title={
            canRestore
              ? 'Open a new shell here and resume the most-recent Claude session (claude --continue)'
              : 'The original folder no longer exists — nothing to resume'
          }
        >
          <ProviderIcon provider="claude" size={13} />
          Resume Claude
        </Button>
        <Button
          variant="secondary"
          onClick={onRestore}
          disabled={!canRestore}
          className="!py-1 text-xs-flat"
          title={
            canRestore
              ? 'Open a new shell in this folder'
              : 'The original folder no longer exists — nothing to reopen'
          }
        >
          <PlayIcon size={13} />
          Start a fresh shell here
        </Button>
      </div>
      <div ref={v.rootRef} className="relative min-h-0 flex-1">
        <div ref={v.containerRef} className="h-full overflow-hidden p-1.5" />
        {v.search.open && (
          <div className="absolute right-2 top-2 z-10">
            <TerminalSearchBar
              query={v.search.query}
              noMatch={v.search.noMatch}
              resultIndex={v.search.resultIndex}
              resultCount={v.search.resultCount}
              onQueryChange={v.search.onQueryChange}
              onNext={v.search.next}
              onPrev={v.search.prev}
              onClose={v.search.close}
            />
          </div>
        )}
      </div>
    </div>
  );
}
