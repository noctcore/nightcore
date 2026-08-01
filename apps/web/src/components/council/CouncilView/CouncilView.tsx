/**
 * The Council canvas surface (issue #352) — the only genuinely-new Council UI. A thin
 * shell over {@link useCouncilView}: idle shows the start panel; a live/settled run
 * shows the seat-node canvas beside the team-chat projection of the `nc:debate` bus.
 *
 * Human controls: convene (from the `research` preset), the kill switch (safety #4), the
 * Converge gavel (#353), and — while a run is live — broadcast-all / DM-one / steer-stage
 * (#361). The last three go through the {@link HumanInputBar}, which dispatches a
 * CONDUCTOR directive; the Conductor quotes + injection-scans the message into the target
 * seat(s)' next mediated turn. Injecting human text straight into a seat (`sendInput`)
 * would bypass the moderated bus (safety #1/#2) and is used nowhere in this feature.
 */
import {
  AgentsIcon,
  Button,
  EmptyState,
  fadeRise,
  FolderIcon,
  HistoryIcon,
  m,
  StatusDot,
} from '@/components/ui';

import { ConvergeGavel } from '../ConvergeGavel';
import type { CouncilPhase } from '../council.types';
import { CouncilReplay } from '../CouncilReplay';
import { CouncilStartPanel } from '../CouncilStartPanel';
import { HumanInputBar } from '../HumanInputBar';
import { ReplyDiff } from '../ReplyDiff';
import { SeatCanvas } from '../SeatCanvas';
import { TeamChat } from '../TeamChat';
import { useCouncilView } from './CouncilView.hooks';
import type { CouncilViewProps } from './CouncilView.types';

/** The status pill copy + tone per phase. */
const PHASE_STATUS: Record<CouncilPhase, { label: string; className: string }> = {
  idle: { label: 'Idle', className: 'text-muted-foreground' },
  running: { label: 'Live', className: 'text-success' },
  converged: { label: 'Awaiting your ruling', className: 'text-primary' },
  resolved: { label: 'Resolved', className: 'text-success' },
  stopped: { label: 'Stopped', className: 'text-muted-foreground' },
};

export function CouncilView(props: CouncilViewProps) {
  const view = useCouncilView(props);
  const status = PHASE_STATUS[view.phase];
  // While live, name the current stage in the pill: "Live · Debate · round 2" (GOV-6).
  const statusLabel =
    view.phase === 'running' && view.liveStage !== null
      ? `Live · ${view.liveStage}`
      : status.label;
  // At Converge the board becomes the judging surface: the seats' replies aligned
  // side-by-side (disagreement is the product) beneath the human's gavel (#353).
  const atConverge = view.phase === 'converged' || view.phase === 'resolved';

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
            {view.isLive && <StatusDot colorClass="bg-success" pulse />}
            {statusLabel}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {view.isLive && (
            // The kill switch (safety #4) — always live while a council runs, prominent +
            // labeled (danger), halts turn-taking immediately.
            <Button variant="danger" onClick={view.kill}>
              Kill council
            </Button>
          )}
          {view.replay.available && !view.replay.active && (
            <Button variant="secondary" onClick={view.replay.enter}>
              <HistoryIcon size={13} aria-hidden />
              Replay
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
      ) : view.replay.active ? (
        // Read-only replay of the finished run (safety #7): reconstruct the append-only
        // transcript in order. It re-renders recorded entries — never re-dispatches.
        <CouncilReplay transcript={view.replay.transcript} onExit={view.replay.exit} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {atConverge ? (
              <ReplyDiff rounds={view.replyRounds} />
            ) : (
              <SeatCanvas
                seats={view.transcript.seats}
                phase={view.phase}
                routing={view.routing}
              />
            )}
            {atConverge ? (
              // The human Converge gavel (#353) — P1's terminal authority (safety #7).
              // It only DISPATCHES the human's verdict through the Conductor; it never
              // feeds text into a seat prompt (the moderated bus stays the sole path).
              // Fade+rises in as the board hands over to judging (GOV-17).
              <m.div variants={fadeRise} initial="initial" animate="animate">
                <ConvergeGavel
                  positions={view.positions}
                  onResolve={view.resolve}
                  resolved={view.resolved}
                  verdict={view.verdict}
                />
              </m.div>
            ) : (
              // Broadcast-all / DM-one / steer-stage (#361). The bar DISPATCHES the
              // human's message to the Conductor, which quotes + injection-scans it and
              // stages it for the target seat(s)' next mediated turn — it never feeds text
              // into a seat via `sendInput` (safety #1/#2). Disabled while no run is live.
              <HumanInputBar
                seatIds={view.transcript.seats.map((seat) => seat.seatId)}
                onSend={view.sendHumanInput}
                live={view.isLive}
              />
            )}
          </div>
          <TeamChat chat={view.transcript.chat} />
        </div>
      )}
    </div>
  );
}
