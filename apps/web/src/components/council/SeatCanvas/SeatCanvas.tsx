/**
 * The seat-node canvas (issues #352 / #371) — a responsive grid of seat nodes, each
 * rendering that seat's own contribution stream from the `nc:debate` transcript, plus an
 * EDITABLE routing row ("Informed by") that rewires which peers inform the seat.
 *
 * Rendering choice: the design calls for a React-Flow node/edge canvas, but at ≤4 seats
 * the routing graph is tiny, and `@xyflow/react` is a heavy client-bundle dependency for
 * a board that barely moves. So the edges are rendered as per-node "Informed by" TOGGLES
 * — a faithful, keyboard-accessible representation of the directed "A informs B" edges,
 * with zero new dependencies and no client-bundle-gate risk (the lighter option the slice
 * prefers). Toggling a chip adds/removes the directed edge `peer → this seat`.
 *
 * A routing edit is NOT a text write into a seat: it is a CONDUCTOR DIRECTIVE (routed via
 * `routing.toggle` → `set_council_routing` → the Conductor), and it only FILTERS which
 * already-mediated, quoted, injection-scanned peers a seat hears next Debate round — it
 * can never introduce an un-mediated seat→seat path (safety #1/#2). Each node still reuses
 * the shared `<Markdown>` primitive and stays a pure READER of the stream (never a PTY,
 * never a text sink back into a prompt).
 */
import { AgentsIcon, Badge, EmptyState, fadeRise, m, Markdown, stagger } from '@/components/ui';

import { SEAT_ROLE_TONE } from '../council-roles';
import type { SeatCanvasProps } from './SeatCanvas.types';

export function SeatCanvas({ seats, phase, routing }: SeatCanvasProps) {
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
      <p
        className="text-2xs text-muted-foreground"
        title={
          routing === undefined
            ? undefined
            : routing.editable
              ? 'Toggle who informs each seat; edits apply next debate round and flow through the conductor — a seat only ever receives quoted, scanned peer content.'
              : 'Who informed whom in this run. Routing is editable only while the council is live.'
        }
      >
        Each node is a seat's live stream
        {routing !== undefined && ' — its “Informed by” row is the routing policy'}
        {routing?.open === true && ' (open — every seat informs every other)'}.
      </p>
      <m.div
        variants={stagger}
        initial="initial"
        animate="animate"
        className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]"
      >
        {seats.map((seat) => {
          const peers =
            routing === undefined
              ? []
              : seats.filter((other) => other.seatId !== seat.seatId);
          return (
            <m.section
              key={seat.seatId}
              variants={fadeRise}
              aria-label={`Seat ${seat.seatId} (${seat.role})`}
              className="flex min-h-[180px] flex-col rounded-xl border border-border bg-card"
            >
              <header className="flex items-center gap-2 border-b border-border px-3 py-2">
                <AgentsIcon size={14} className="text-primary" aria-hidden />
                <span className="truncate text-sm-flat font-medium text-foreground">
                  {seat.seatId}
                </span>
                <Badge tone={SEAT_ROLE_TONE[seat.role]} className="ml-auto capitalize">
                  {seat.role}
                </Badge>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
                <Markdown className="text-xs-plus text-foreground/90">
                  {seat.latestContent}
                </Markdown>
              </div>
              {routing !== undefined && peers.length > 0 && (
                <div className="flex flex-col gap-1.5 border-t border-border px-3 py-2">
                  <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    Informed by
                  </span>
                  <div
                    className="flex flex-wrap gap-1.5"
                    role="group"
                    aria-label={`Seats that inform ${seat.seatId}`}
                  >
                    {peers.map((peer) => {
                      const active = routing.informs(peer.seatId, seat.seatId);
                      return (
                        <button
                          key={peer.seatId}
                          type="button"
                          aria-pressed={active}
                          aria-label={`${peer.seatId} informs ${seat.seatId}`}
                          disabled={!routing.editable}
                          onClick={() => routing.toggle(peer.seatId, seat.seatId)}
                          className={`rounded-full border px-2 py-0.5 text-2xs transition-colors disabled:cursor-default disabled:opacity-70 ${
                            active
                              ? 'border-primary/50 bg-primary/15 text-primary'
                              : 'border-border bg-transparent text-muted-foreground'
                          } ${routing.editable ? 'hover:border-primary/60' : ''}`}
                        >
                          {peer.seatId}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <footer className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-2xs text-muted-foreground">
                <span className="capitalize">{seat.latestStage}</span>
                <span aria-hidden>·</span>
                <span className="tabular-nums">
                  {seat.messages.length} turn{seat.messages.length === 1 ? '' : 's'}
                </span>
              </footer>
            </m.section>
          );
        })}
      </m.div>
    </div>
  );
}
