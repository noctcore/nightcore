/**
 * The seat-node canvas (issue #352) — a responsive grid of seat nodes, each rendering
 * that seat's own contribution stream from the `nc:debate` transcript.
 *
 * Rendering choice: the design calls for a React-Flow node/edge canvas, but P1 edges
 * are STATIC (editable routing is P2) and `@xyflow/react` is not a dependency — adding
 * it would pull a heavy client-bundle chunk for a board that never moves. So this ships
 * the sanctioned `TerminalGrid`-style grid fallback: an auto-fill CSS grid of seat
 * nodes, no new dependency, no client-bundle gate risk. Each node reuses the shared
 * `<Markdown>` primitive (the same Shiki/markdown rendering the board's ActivityLog
 * uses) — the canvas is a pure READER of the stream, never a PTY (the terminal seam is
 * user-only) and never a text sink back into a seat prompt (safety #1/#2).
 */
import { AgentsIcon, Badge, EmptyState, Markdown } from '@/components/ui';

import type { SeatCanvasProps } from './SeatCanvas.types';

export function SeatCanvas({ seats, phase }: SeatCanvasProps) {
  if (seats.length === 0) {
    return (
      <EmptyState
        icon={<AgentsIcon size={28} />}
        title={phase === 'idle' ? 'No council running' : 'Waiting for seats'}
        description={
          phase === 'idle'
            ? 'Convene a council to see its seats debate here.'
            : 'The conductor is framing the debate — seats appear as they take their first turn.'
        }
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <p className="text-2xs text-muted-foreground">
        Each node is a seat's live stream. Routing (who informs whom) is fixed by the
        preset in P1 — editable edges land later.
      </p>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
        {seats.map((seat) => (
          <section
            key={seat.seatId}
            aria-label={`Seat ${seat.seatId} (${seat.role})`}
            className="flex min-h-[180px] flex-col rounded-xl border border-border bg-card"
          >
            <header className="flex items-center gap-2 border-b border-border px-3 py-2">
              <AgentsIcon size={14} className="text-primary" aria-hidden />
              <span className="truncate text-sm-flat font-medium text-foreground">
                {seat.seatId}
              </span>
              <Badge tone="primary" className="ml-auto capitalize">
                {seat.role}
              </Badge>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
              <Markdown className="text-xs-plus text-foreground/90">
                {seat.latestContent}
              </Markdown>
            </div>
            <footer className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-2xs text-muted-foreground">
              <span className="capitalize">{seat.latestStage}</span>
              <span aria-hidden>·</span>
              <span>
                {seat.messages.length} turn{seat.messages.length === 1 ? '' : 's'}
              </span>
            </footer>
          </section>
        ))}
      </div>
    </div>
  );
}
