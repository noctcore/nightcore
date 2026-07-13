/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  DebateTranscriptEntrySchema,
  type NightcoreEvent,
  type SurfaceCommand,
} from '@nightcore/contracts';

import { CouncilRouter } from './council-router.js';

/** The `debate-entry` member, narrowed for the assertions below. */
type DebateEntryEvent = Extract<NightcoreEvent, { type: 'debate-entry' }>;

/** Poll `cond` across macrotasks (the fire-and-forget run drives its seats over
 *  several ticks) until it holds or the attempt budget is spent. */
async function waitFor(cond: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('CouncilRouter — the nc:debate emit seam', () => {
  test('a start-council run round-trips every appended entry to a debate-entry event', async () => {
    let nextSessionId = 1;
    const listeners = new Set<(event: NightcoreEvent) => void>();
    const emitted: NightcoreEvent[] = [];

    const router = new CouncilRouter({
      // Each seat turn spawns a one-shot session; complete it on the next macrotask
      // with stable content so the run drives Frame → Propose → Debate → Converge and
      // appends transcript entries the emit seam forwards.
      startSession: () => {
        const sessionId = nextSessionId++;
        setTimeout(() => {
          const completed = {
            type: 'session-completed',
            sessionId,
            result: `seat-${sessionId} position`,
            numTurns: 1,
            durationMs: 0,
          } as unknown as NightcoreEvent;
          for (const listener of [...listeners]) listener(completed);
        }, 0);
        return sessionId;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (event) => emitted.push(event),
      logger: undefined,
    });

    const command: SurfaceCommand = {
      type: 'start-council',
      runId: 'council-run-1',
      presetId: 'research',
      objective: 'Pick a strategy.',
    };
    expect(router.handles(command)).toBe(true);
    router.dispatch(command);

    const isDebateEntry = (e: NightcoreEvent): e is DebateEntryEvent =>
      e.type === 'debate-entry';
    // The run parks a Converge decision for the human judge — its converge note is the
    // last thing recorded, so waiting for it means the whole transcript has streamed.
    await waitFor(() =>
      emitted
        .filter(isDebateEntry)
        .some((e) => e.entry.stage === 'converge' && e.entry.kind === 'note'),
    );

    const debateEvents = emitted.filter(isDebateEntry);
    expect(debateEvents.length).toBeGreaterThan(0);
    for (const event of debateEvents) {
      // The run id rides on the event (the entry keys externally in the store), so the
      // canvas can filter a run's stream by it.
      expect(event.runId).toBe('council-run-1');
      // The wrapped entry validates against the authoritative transcript contract.
      expect(DebateTranscriptEntrySchema.safeParse(event.entry).success).toBe(true);
    }
    // Every emitted debate event is a well-formed `NightcoreEvent` (so the sidecar's
    // outbound safeParse and the web narrower both accept it on the wire).
    expect(
      debateEvents.every((e) => e.type === 'debate-entry' && typeof e.runId === 'string'),
    ).toBe(true);
  });

  test('kill-council for an unknown run is a no-op (never throws)', () => {
    const router = new CouncilRouter({
      startSession: () => 1,
      subscribe: () => () => {},
      emit: () => {},
      logger: undefined,
    });
    expect(() =>
      router.dispatch({ type: 'kill-council', runId: 'nope' }),
    ).not.toThrow();
  });
});
