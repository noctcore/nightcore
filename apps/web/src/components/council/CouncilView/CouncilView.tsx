/**
 * The Council canvas surface (issue #352) — the only genuinely-new Council UI. A thin
 * shell over {@link useCouncilView}: idle shows the start panel; a live/settled run
 * shows the seat-node canvas beside the team-chat projection of the `nc:debate` bus.
 *
 * Human controls shipped in P1: convene (from the `research` preset), and the kill
 * switch (safety #4). Broadcast-all / DM-one / steer-stage need a conductor-mediated
 * human-input command that a follow-up slice adds — injecting human text straight into
 * a seat would bypass the moderated, quoted, injection-scanned bus (safety #1/#2), so
 * this slice keeps the canvas a pure READER and renders those controls as a disabled
 * affordance. #353 adds the human Converge (judge/accept/reject).
 */
import { AgentsIcon, BroadcastIcon, Button, EmptyState, FolderIcon } from '@/components/ui';

import type { CouncilPhase } from '../council.types';
import { CouncilStartPanel } from '../CouncilStartPanel';
import { SeatCanvas } from '../SeatCanvas';
import { TeamChat } from '../TeamChat';
import { useCouncilView } from './CouncilView.hooks';
import type { CouncilViewProps } from './CouncilView.types';

/** The status pill copy + tone per phase. */
const PHASE_STATUS: Record<CouncilPhase, { label: string; className: string }> = {
  idle: { label: 'Idle', className: 'text-muted-foreground' },
  running: { label: 'Live', className: 'text-emerald-400' },
  converged: { label: 'Converged — awaiting your judgment', className: 'text-primary' },
  stopped: { label: 'Stopped', className: 'text-muted-foreground' },
};

export function CouncilView(props: CouncilViewProps) {
  const view = useCouncilView(props);
  const status = PHASE_STATUS[view.phase];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-5 py-3">
        <AgentsIcon size={16} className="text-primary" aria-hidden />
        <h1 className="text-sm-flat font-semibold text-foreground">Council</h1>
        {view.projectName !== null && (
          <span className="text-xs-plus text-muted-foreground">· {view.projectName}</span>
        )}
        {view.phase !== 'idle' && (
          <span className={`flex items-center gap-1.5 text-xs-plus ${status.className}`}>
            {view.isLive && (
              <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" />
            )}
            {status.label}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {view.isLive && (
            <Button variant="danger" onClick={view.kill}>
              Kill council
            </Button>
          )}
          {view.phase !== 'idle' && !view.isLive && (
            <Button variant="secondary" onClick={view.reset}>
              New council
            </Button>
          )}
        </div>
      </header>

      {!view.hasProject && view.phase === 'idle' ? (
        <EmptyState
          icon={<FolderIcon size={32} />}
          title="No active project"
          description="Open a project to convene a council over it. Each council debates the active project's code."
        />
      ) : view.phase === 'idle' ? (
        <CouncilStartPanel onStart={view.start} disabled={!view.hasProject} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <SeatCanvas seats={view.transcript.seats} phase={view.phase} />
            {/* Broadcast/DM/steer bar — DEFERRED: a conductor-mediated human-input
                command is a follow-up slice; feeding text straight into a seat would
                bypass the moderated bus (safety #1/#2). Rendered disabled so the layout
                matches the design intent and the deferral is visible, not silent. */}
            <div
              className="flex shrink-0 items-center gap-2 border-t border-border bg-card/40 px-4 py-2.5"
              aria-label="Broadcast to the council (coming soon)"
            >
              <BroadcastIcon size={14} className="text-muted-foreground" aria-hidden />
              <span className="text-2xs text-muted-foreground">
                Broadcast · DM · steer-stage arrive with the conductor's mediated
                human-input seam — the canvas stays read-only until then.
              </span>
              <Button variant="secondary" disabled className="ml-auto">
                Broadcast to all
              </Button>
            </div>
          </div>
          <TeamChat chat={view.transcript.chat} />
        </div>
      )}
    </div>
  );
}
