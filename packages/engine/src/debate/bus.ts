/**
 * The conductor-mediated Council debate bus (issue #348, safety non-negotiable #1 --
 * the injection firewall).
 *
 * Seats emit onto a moderated shared bus, scoped by stage. The bus's defining
 * property is WHO may write it: the write path is owned by a conductor/moderator
 * interface ({@link ConductorBus}), and a seat is only ever handed a READ-ONLY
 * {@link SeatBusView}. A seat therefore has NO API -- at the type level or at runtime
 * -- to write into another seat's context. Agent-to-agent command authority is made
 * structurally impossible, not merely discouraged: the two capabilities live behind
 * two different handles minted by this bus, and the orchestrator keeps the conductor
 * handle to itself.
 *
 * There is NO conductor state machine here -- that is a downstream slice. This module
 * defines the mediated WRITE SURFACE the future conductor will drive, and wires two
 * safety invariants into that surface:
 *  - #1: seats get {@link SeatBusView} (read-only); all writes go through
 *    {@link ConductorBus}. The append-only transcript store is private to the bus, so
 *    a seat cannot reach it.
 *  - #2: every inter-seat relay ({@link ConductorBus.deliverBetweenSeats}) runs the
 *    source seat's text through quoted-untrusted delivery (injection scan + quoted
 *    fence) BEFORE it is recorded/routed, and stamps the scan result on the entry.
 *
 * Every write is recorded on the append-only transcript (safety #7).
 */
import type {
  DebateSeatRole,
  DebateStage,
  DebateTranscriptEntry,
} from '@nightcore/contracts';

import { quoteForSeat } from './quoted-delivery.js';
import {
  type DebateEntryInput,
  DebateTranscriptStore,
} from './transcript-store.js';

/** The read-only handle a SEAT holds. It can observe the moderated bus but has no
 *  method -- none exists -- to write it. This is the concrete shape of safety #1: a
 *  seat cannot record its own message, relay to a peer, or reach the store. */
export interface SeatBusView {
  readonly seatId: string;
  /** The ordered, immutable transcript for this run (for a seat to read context). */
  read(): readonly DebateTranscriptEntry[];
}

/** A seat's own contribution the conductor records onto the bus on its behalf. */
export interface SeatMessage {
  stage: DebateStage;
  seatId: string;
  role: DebateSeatRole;
  content: string;
  /** Links this contribution to the broadcast it replies to, if any. */
  broadcastId?: string;
}

/** One seat's text to be relayed toward other seats as quoted, scanned data. */
export interface InterSeatDelivery {
  stage: DebateStage;
  /** The SOURCE seat whose text is being relayed (never trusted as an instruction). */
  fromSeatId: string;
  role: DebateSeatRole;
  content: string;
  broadcastId?: string;
}

/** The outcome of an inter-seat relay: the recorded entry plus the quoted rendering
 *  the conductor routes onward and the injection-scan result. */
export interface DeliveryOutcome {
  entry: DebateTranscriptEntry;
  /** The quoted, fenced text safe to hand to another seat (never a bare instruction). */
  text: string;
  /** Injection-scan reasons (empty = scanned clean). */
  reasons: string[];
  flagged: boolean;
}

/**
 * The mediated WRITE surface for one council run. Held ONLY by the orchestrator/
 * conductor -- never handed to a seat. Every method appends to the append-only
 * transcript; there is no update or delete.
 */
export interface ConductorBus {
  readonly conductorId: string;
  /** Send one prompt to all seats at once. Mints a `broadcastId` the replies carry
   *  (grouping one broadcast's side-by-side replies) and records the broadcast. */
  broadcast(stage: DebateStage, content: string): {
    broadcastId: string;
    entry: DebateTranscriptEntry;
  };
  /** Record a seat's OWN contribution onto the bus. The seat cannot call this -- the
   *  conductor records on its behalf, which is what keeps write authority mediated. */
  postSeatMessage(message: SeatMessage): DebateTranscriptEntry;
  /** Relay one seat's text toward other seats. Runs quoted-untrusted delivery
   *  (injection scan + quoted fence) BEFORE recording, and stamps the scan result on
   *  the entry (safety #2). Returns the quoted text for the conductor to route. */
  deliverBetweenSeats(delivery: InterSeatDelivery): DeliveryOutcome;
  /** Record a conductor/system annotation (a stage transition, a moderation note). */
  note(stage: DebateStage, content: string): DebateTranscriptEntry;
}

/**
 * The debate bus. Owns the append-only transcript store PRIVATELY and mints the two
 * capability handles:
 *  - {@link DebateBus.conductor} -> the write surface (orchestrator-only).
 *  - {@link DebateBus.seatView} -> a read-only view (handed to seats).
 */
export class DebateBus {
  private readonly store: DebateTranscriptStore;

  constructor(store: DebateTranscriptStore = new DebateTranscriptStore()) {
    this.store = store;
  }

  /** Mint the mediated write surface for a run. The orchestrator keeps this; it is
   *  NEVER handed to a seat. */
  conductor(councilRunId: string, conductorId = 'conductor'): ConductorBus {
    const store = this.store;

    const append = (input: DebateEntryInput): DebateTranscriptEntry =>
      store.append(councilRunId, input);

    return {
      conductorId,
      broadcast(stage, content) {
        // Derive the id from the seq this entry is about to receive: unique within
        // the run and deterministic (no RNG), so replies can be grouped and tests
        // are reproducible.
        const broadcastId = `bc-${store.size(councilRunId)}`;
        const entry = append({
          stage,
          seatId: conductorId,
          role: 'conductor',
          kind: 'broadcast',
          content,
          broadcastId,
        });
        return { broadcastId, entry };
      },
      postSeatMessage({ stage, seatId, role, content, broadcastId }) {
        return append({
          stage,
          seatId,
          role,
          kind: 'message',
          content,
          ...(broadcastId !== undefined ? { broadcastId } : {}),
        });
      },
      deliverBetweenSeats({ stage, fromSeatId, role, content, broadcastId }) {
        const delivery = quoteForSeat(fromSeatId, content);
        const entry = append({
          stage,
          seatId: fromSeatId,
          role,
          kind: 'delivery',
          content: delivery.text,
          injectionFlags: delivery.reasons,
          ...(broadcastId !== undefined ? { broadcastId } : {}),
        });
        return {
          entry,
          text: delivery.text,
          reasons: delivery.reasons,
          flagged: delivery.flagged,
        };
      },
      note(stage, content) {
        return append({
          stage,
          seatId: conductorId,
          role: 'conductor',
          kind: 'note',
          content,
        });
      },
    };
  }

  /** Mint a seat's READ-ONLY view of a run. The returned object exposes `read` only:
   *  it holds no reference to the store and has no write method, so a seat structurally
   *  cannot write the bus or reach the transcript (safety #1). */
  seatView(councilRunId: string, seatId: string): SeatBusView {
    const store = this.store;
    return {
      seatId,
      read: () => store.read(councilRunId),
    };
  }
}
