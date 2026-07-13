/**
 * The Conductor's transcript fan-out (issue #350) — split out of `conductor.ts` so the
 * state machine stays under the engine file-size cap.
 *
 * {@link observeBus} wraps a {@link ConductorBus} so every write is mirrored to an
 * `onEntry` sink: the SINGLE place transcript entries fan out for audit + the future
 * `nc:debate` stream (#352). It only observes — it adds no write surface a seat could
 * reach, so the injection firewall (safety #1) is unchanged.
 */
import type { DebateTranscriptEntry } from '@nightcore/contracts';

import type { ConductorBus } from './bus.js';

/** Wrap a {@link ConductorBus} so every write is observed by `onEntry` — the single
 *  place transcript entries fan out (audit + the future nc:debate stream). */
export function observeBus(
  bus: ConductorBus,
  onEntry: (entry: DebateTranscriptEntry) => void,
): ConductorBus {
  return {
    conductorId: bus.conductorId,
    broadcast(stage, content) {
      const result = bus.broadcast(stage, content);
      onEntry(result.entry);
      return result;
    },
    postSeatMessage(message) {
      const entry = bus.postSeatMessage(message);
      onEntry(entry);
      return entry;
    },
    deliverBetweenSeats(delivery) {
      const outcome = bus.deliverBetweenSeats(delivery);
      onEntry(outcome.entry);
      return outcome;
    },
    note(stage, content) {
      const entry = bus.note(stage, content);
      onEntry(entry);
      return entry;
    },
  };
}
