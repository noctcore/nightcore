/**
 * The Council REPLAY surface (issue #354, safety non-negotiable #7) — reconstructs a
 * finished run by re-rendering its append-only transcript in order. It is strictly
 * READ-ONLY: it drives the SAME seat canvas + team-chat projection off a playback cursor
 * and NEVER re-dispatches a seat or resends a command (it holds no bridge command; the
 * cursor only walks recorded entries). The interactive judging surface (the gavel) and
 * the kill switch are deliberately absent — a replay observes, it does not act.
 */
import { Button, CloseIcon, HistoryIcon, PauseIcon, PlayIcon, RefreshIcon } from '@/components/ui';

import { SeatCanvas } from '../SeatCanvas';
import { TeamChat } from '../TeamChat';
import { useCouncilReplay } from './CouncilReplay.hooks';
import type { CouncilReplayProps } from './CouncilReplay.types';

export function CouncilReplay({ transcript, onExit }: CouncilReplayProps) {
  const replay = useCouncilReplay(transcript);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Replay control bar — playback only; no seat can be dispatched from here. */}
        <div
          className="flex shrink-0 items-center gap-3 border-b border-border bg-card/40 px-4 py-2.5"
          role="group"
          aria-label="Replay controls"
        >
          <span className="flex items-center gap-1.5 text-xs-plus font-medium text-primary">
            <HistoryIcon size={14} aria-hidden />
            Replay
          </span>
          <Button
            variant="secondary"
            onClick={replay.toggle}
            aria-label={replay.playing ? 'Pause replay' : 'Play replay'}
          >
            {replay.playing ? (
              <PauseIcon size={13} aria-hidden />
            ) : (
              <PlayIcon size={13} aria-hidden />
            )}
            {replay.playing ? 'Pause' : 'Play'}
          </Button>
          <Button variant="secondary" onClick={replay.restart} aria-label="Restart replay">
            <RefreshIcon size={13} aria-hidden />
            Restart
          </Button>
          <input
            type="range"
            min={0}
            max={replay.total}
            value={replay.cursor}
            onChange={(e) => replay.seek(Number(e.target.value))}
            aria-label="Replay position"
            className="min-w-0 flex-1 accent-primary"
          />
          <span
            className="shrink-0 font-mono text-2xs text-muted-foreground"
            aria-live="polite"
          >
            {replay.cursor} / {replay.total}
          </span>
          <Button variant="ghost" onClick={onExit} aria-label="Exit replay">
            <CloseIcon size={13} aria-hidden />
            Exit
          </Button>
        </div>
        <SeatCanvas seats={replay.folded.seats} phase="running" />
      </div>
      <TeamChat chat={replay.folded.chat} />
    </div>
  );
}
