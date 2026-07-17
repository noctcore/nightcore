/**
 * The Council routing DIRECTIVE plumbing (issue #371) — split out of `conductor.ts` so
 * the state machine stays under the engine file-size cap, mirroring the `conductor-*`
 * helper split (`conductor-converge.ts`, `conductor-observer.ts`).
 *
 * The editable canvas edges are a CONDUCTOR DIRECTIVE, never a direct seat write. This
 * module owns the two orchestration steps the Conductor delegates: seeding a run's live
 * routing handle from its preset at Frame, and applying a rewire onto a run in flight. The
 * rewire records the change onto the append-only transcript through the run's mediated,
 * observer-wrapped bus (never a direct store write — safety #1), which also streams it
 * over `nc:debate` and keeps the run replayable (#7). The graph itself — the "A informs B"
 * filter — lives in {@link RoutingPolicy} (`council-routing.ts`); this module is the
 * orchestration seam around it.
 */
import type { CouncilRouting, CouncilRoutingEdge } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import type { ConductorBus } from './bus.js';
import type { SeatContext } from './conductor-types.js';
import { RoutingPolicy, type RoutingUpdate } from './council-routing.js';

/** The live handles a routing directive needs to reach a RUNNING run: its mediated,
 *  observer-wrapped bus (so a routing note streams + audits), its mutable routing graph,
 *  and its seat ids (an edit naming an unknown seat is dropped). Set at Frame, cleared
 *  when the run leaves the driving loop. */
export interface RunRoutingRuntime {
  readonly bus: ConductorBus;
  readonly routing: RoutingPolicy;
  readonly seatIds: ReadonlySet<string>;
}

/** Build a run's live routing handle, seeded from its preset's routing graph. The human
 *  rewires it live through {@link applyRoutingDirective}; the Debate loop reads its
 *  {@link RoutingPolicy.informers} fresh each round. */
export function seedRoutingRuntime(
  bus: ConductorBus,
  routing: CouncilRouting,
  seats: readonly SeatContext[],
): RunRoutingRuntime {
  const seatIds = new Set(seats.map((seat) => seat.seatId));
  return {
    bus,
    // Validate the preset seed against the run's real seats, identical to a live edit (#377).
    routing: new RoutingPolicy(routing, seatIds),
    seatIds,
  };
}

/**
 * Apply a routing rewire to a run in flight — the editable canvas edges (issue #371). It
 * REPLACES the run's "A informs B" edge set (dropping edges that name a seat the run does
 * not define) and records the change as a CONDUCTOR note onto the append-only transcript
 * through the run's mediated bus. The edit only changes WHICH already-mediated, quoted,
 * injection-scanned peers reach a seat next Debate round; it can never introduce an
 * un-mediated agent-to-agent path (safety #1/#2). Refused (a no-op) for an unknown /
 * already-finished run (`runtime === undefined`).
 */
export function applyRoutingDirective(
  runtime: RunRoutingRuntime | undefined,
  councilRunId: string,
  edges: readonly CouncilRoutingEdge[],
  logger: Logger | undefined,
): RoutingUpdate {
  if (runtime === undefined) {
    return { ok: false, reason: 'no active council run to route' };
  }
  const applied = runtime.routing.update(edges, runtime.seatIds);
  runtime.bus.note('debate', runtime.routing.describe());
  logger?.info('council routing updated', {
    councilRunId,
    edges: applied.length,
  });
  return { ok: true, edges: applied };
}
