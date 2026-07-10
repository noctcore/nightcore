import '@xterm/xterm/css/xterm.css';

import { Button, HistoryIcon, PlayIcon } from '@/components/ui';

import { restoredIdentityLabel, restoredIdentityTitle } from '../terminal-shared';
import { useTerminalReadonlyPane } from './TerminalReadonlyPane.hooks';
import type { TerminalReadonlyPaneProps } from './TerminalReadonlyPane.types';

/** The restored-session chrome: a dimmed "session ended — read-only" marker plus
 *  the shell + cwd, matching the live pane's identity header layout. */
function RestoredHeader({ shell, cwd }: { shell: string; cwd: string }) {
  return (
    <div
      title={restoredIdentityTitle()}
      className="flex items-center gap-2 border-b border-border bg-black/25 px-3 py-1.5 text-[11px]"
    >
      <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
        <HistoryIcon size={12} aria-hidden />
        {restoredIdentityLabel()}
      </span>
      <span className="text-muted-foreground/50" aria-hidden>
        ·
      </span>
      <span className="truncate font-mono text-muted-foreground/70">{shell}</span>
      <span className="truncate font-mono text-muted-foreground/50">{cwd}</span>
    </div>
  );
}

/** A restored (dead) session replayed READ-ONLY (decision 3): its persisted
 *  scrollback in an input-disabled xterm, under a chrome that says the shell ended,
 *  with a "start a fresh shell here" action (disabled — with a hint — when the
 *  original folder is gone). A thin shell; the replay lives in the hook. */
export function TerminalReadonlyPane({ info, canRestore, onRestore }: TerminalReadonlyPaneProps) {
  const { containerRef } = useTerminalReadonlyPane(info.id);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0a0a0f]">
      <RestoredHeader shell={info.shell} cwd={info.cwd} />
      <div className="flex items-center gap-3 border-b border-border/60 bg-warning/[0.06] px-3 py-2">
        <span className="min-w-0 flex-1 text-[12px] text-muted-foreground">
          {canRestore
            ? 'This session ended. Start a fresh shell to continue in the same folder.'
            : 'This session ended, and its original folder is no longer available.'}
        </span>
        <Button
          variant="secondary"
          onClick={onRestore}
          disabled={!canRestore}
          className="!py-1 text-[12px]"
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
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden p-1.5" />
    </div>
  );
}
