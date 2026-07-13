/** Props for the {@link import('./SeatCanvas').SeatCanvas} seat-node grid. */
import type { CouncilPhase, SeatStream } from '../council.types';

export interface SeatCanvasProps {
  /** The seat nodes, derived from the live transcript (a seat appears once it speaks). */
  seats: SeatStream[];
  /** The canvas phase — drives the empty-state copy (waiting vs. no seats yet). */
  phase: CouncilPhase;
}
