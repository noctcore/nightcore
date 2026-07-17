/** Props for the {@link import('./SeatCanvas').SeatCanvas} seat-node grid. */
import type {
  CouncilPhase,
  CouncilRoutingControls,
  SeatStream,
} from '../council.types';

export interface SeatCanvasProps {
  /** The seat nodes, derived from the live transcript (a seat appears once it speaks). */
  seats: SeatStream[];
  /** The canvas phase — drives the empty-state copy (waiting vs. no seats yet). */
  phase: CouncilPhase;
  /** The editable routing controller (issue #371): when present, each node exposes an
   *  "Informed by" row of toggles that rewire which peers inform the seat, dispatched
   *  through the Conductor. OMITTED for read-only surfaces (replay) — the routing history
   *  is legible there as conductor notes in the team-chat, so the chips are hidden. */
  routing?: CouncilRoutingControls;
}
