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

const isDebateEntry = (e: NightcoreEvent): e is DebateEntryEvent =>
  e.type === 'debate-entry';

/** A router wired to fake seat sessions: each seat turn completes on the next macrotask
 *  with stable content, so the run drives Frame → Propose → Debate → Converge and the
 *  emit seam forwards every appended entry into `emitted`. */
type StartSessionCommand = Extract<SurfaceCommand, { type: 'start-session' }>;

function setup(): {
  router: CouncilRouter;
  emitted: NightcoreEvent[];
  starts: StartSessionCommand[];
  interrupted: number[];
} {
  let nextSessionId = 1;
  const listeners = new Set<(event: NightcoreEvent) => void>();
  const emitted: NightcoreEvent[] = [];
  const starts: StartSessionCommand[] = [];
  const interrupted: number[] = [];

  const router = new CouncilRouter({
    startSession: (command) => {
      starts.push(command);
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
    interruptSession: (sessionId) => interrupted.push(sessionId),
    logger: undefined,
  });

  return { router, emitted, starts, interrupted };
}

describe('CouncilRouter — the nc:debate emit seam', () => {
  test('a start-council run round-trips every appended entry to a debate-entry event', async () => {
    const { router, emitted } = setup();

    const command: SurfaceCommand = {
      type: 'start-council',
      runId: 'council-run-1',
      presetId: 'research',
      objective: 'Pick a strategy.',
    };
    expect(router.handles(command)).toBe(true);
    router.dispatch(command);

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

  test('resolve-council-converge routes the human verdict through the Conductor onto the stream (safety #7)', async () => {
    const { router, emitted } = setup();

    router.dispatch({
      type: 'start-council',
      runId: 'council-run-2',
      presetId: 'research',
      objective: 'Pick a strategy.',
    });

    // Wait for the CONDUCTOR park note — the run is now awaiting the human judge.
    await waitFor(() =>
      emitted
        .filter(isDebateEntry)
        .some(
          (e) =>
            e.entry.stage === 'converge' &&
            e.entry.kind === 'note' &&
            e.entry.role === 'conductor',
        ),
    );

    // The human rules — the verdict must flow command → router → CouncilManager →
    // Conductor (the sole bus writer) → append-only transcript → the nc:debate stream.
    const resolve: SurfaceCommand = {
      type: 'resolve-council-converge',
      runId: 'council-run-2',
      decision: 'reject',
      note: 'None is safe until the backfill is rehearsed.',
    };
    expect(router.handles(resolve)).toBe(true);
    router.dispatch(resolve);

    await waitFor(() =>
      emitted
        .filter(isDebateEntry)
        .some((e) => e.entry.role === 'human' && e.entry.stage === 'converge'),
    );

    const verdict = emitted
      .filter(isDebateEntry)
      .map((e) => e.entry)
      .find((entry) => entry.role === 'human' && entry.stage === 'converge');
    // The verdict landed on the append-only transcript as a human-role converge note.
    expect(verdict).toBeDefined();
    expect(verdict?.kind).toBe('note');
    expect(verdict?.content).toContain('REJECT');
    // It rides the same run-tagged debate event every entry does.
    const verdictEvent = emitted
      .filter(isDebateEntry)
      .find((e) => e.entry.role === 'human');
    expect(verdictEvent?.runId).toBe('council-run-2');
  });

  test('set-council-routing routes the routing directive through the Conductor onto the stream (issue #371)', async () => {
    const { router, emitted } = setup();

    const start: SurfaceCommand = {
      type: 'start-council',
      runId: 'council-run-routing',
      presetId: 'research',
      objective: 'Pick a strategy.',
    };
    router.dispatch(start);

    // The run's routing handle is live synchronously after start (run() sets it before its
    // first await), so the edit reaches the Conductor while the run is in flight.
    const setRouting: SurfaceCommand = {
      type: 'set-council-routing',
      runId: 'council-run-routing',
      edges: [{ from: 'proposer-sonnet', to: 'critic-opus' }],
    };
    expect(router.handles(setRouting)).toBe(true);
    router.dispatch(setRouting);

    // The directive is recorded onto the append-only transcript as a CONDUCTOR note (a
    // mediated write — safety #1) and streams over nc:debate like every other entry.
    await waitFor(() =>
      emitted
        .filter(isDebateEntry)
        .some(
          (e) =>
            e.entry.kind === 'note' &&
            e.entry.role === 'conductor' &&
            e.entry.stage === 'debate' &&
            e.entry.content.includes('Routing updated'),
        ),
    );

    const note = emitted
      .filter(isDebateEntry)
      .map((e) => e.entry)
      .find(
        (entry) =>
          entry.stage === 'debate' &&
          entry.kind === 'note' &&
          entry.content.includes('Routing updated'),
      );
    expect(note).toBeDefined();
    expect(note?.content).toContain('critic-opus ← proposer-sonnet');
  });

  test('set-council-routing for an unknown run is a no-op (never throws)', () => {
    const { router } = setup();
    expect(() =>
      router.dispatch({
        type: 'set-council-routing',
        runId: 'nope',
        edges: [{ from: 'a', to: 'b' }],
      }),
    ).not.toThrow();
  });

  test('kill-council for an unknown run is a no-op (never throws)', () => {
    const { router } = setup();
    expect(() =>
      router.dispatch({ type: 'kill-council', runId: 'nope' }),
    ).not.toThrow();
  });

  test('every seat session is dispatched OS-sandboxed + governed at the plan tier (safety #3)', async () => {
    const { router, starts } = setup();

    router.dispatch({
      type: 'start-council',
      runId: 'council-run-3',
      presetId: 'research',
      objective: 'Pick a strategy.',
    });
    await waitFor(() => starts.length > 0);

    // The production wiring forwards SEAT_SESSION_HARDENING onto the underlying
    // `start-session` command, so the existing per-session confinement machinery
    // (Seatbelt + the SDK permission mode) applies to every seat.
    expect(starts.length).toBeGreaterThan(0);
    for (const start of starts) {
      expect(start.kind).toBe('research');
      expect(start.autonomy).toBe('plan');
      expect(start.sandboxWrites).toBe(true);
    }
  });

  test('a build-capable council drives allocate → commit → gauntlet over the PATH-LESS worktree seam, and resolve-worktree-op progresses it (issue #383)', async () => {
    let nextSessionId = 1;
    const listeners = new Set<(event: NightcoreEvent) => void>();
    const emitted: NightcoreEvent[] = [];
    const worktreeOps: string[] = [];
    const ref: { router?: CouncilRouter } = {};

    ref.router = new CouncilRouter({
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
      emit: (event) => {
        emitted.push(event);
        if (event.type !== 'worktree-op-required') return;
        worktreeOps.push(event.op);
        // Simulate the Rust host: reply through the router's OWN `resolve-worktree-op`
        // command (the real resolve path). A red gauntlet exercises the gate override.
        const reply: SurfaceCommand = {
          type: 'resolve-worktree-op',
          requestId: event.requestId,
          ...(event.op === 'allocate'
            ? { worktreePath: `/project/.nightcore/worktrees/${event.councilRunId}` }
            : {}),
          ...(event.op === 'gauntlet'
            ? { gauntletPassed: false, gauntletSummary: 'build output red' }
            : {}),
        };
        queueMicrotask(() => ref.router?.dispatch(reply));
      },
      interruptSession: () => {},
      logger: undefined,
    });

    // `resolve-worktree-op` is a council command the router owns.
    expect(
      ref.router.handles({ type: 'resolve-worktree-op', requestId: 'x' } as SurfaceCommand),
    ).toBe(true);

    ref.router.dispatch({
      type: 'start-council',
      runId: 'council-383',
      presetId: 'ui-bug',
      objective: 'fix the broken submit button',
      projectPath: '/project',
    });

    // The run only reaches Converge AFTER the whole build + gate round-trip completes.
    await waitFor(
      () =>
        emitted
          .filter(isDebateEntry)
          .some((e) => e.entry.stage === 'converge' && e.entry.kind === 'note'),
      400,
    );

    // All three worktree verbs crossed the seam, in order, keyed by the run id — and every
    // request is PATH-LESS (only type/op/councilRunId/requestId; no filesystem path).
    expect(worktreeOps).toEqual(['allocate', 'commit', 'gauntlet']);
    const wtEvents = emitted.filter(
      (e): e is Extract<NightcoreEvent, { type: 'worktree-op-required' }> =>
        e.type === 'worktree-op-required',
    );
    expect(wtEvents).toHaveLength(3);
    for (const e of wtEvents) {
      expect(e.councilRunId).toBe('council-383');
      expect(Object.keys(e).sort()).toEqual(['councilRunId', 'op', 'requestId', 'type']);
    }
    // The Build stage actually ran (the writer session was driven), and the red gate rode
    // the parked decision.
    expect(emitted.filter(isDebateEntry).some((e) => e.entry.stage === 'build')).toBe(true);
  });

  test('every seat session carries the council marker so the reader skips board-FIFO correlation (issue #364)', async () => {
    const { router, starts } = setup();

    router.dispatch({
      type: 'start-council',
      runId: 'council-run-4',
      presetId: 'research',
      objective: 'Pick a strategy.',
    });
    await waitFor(() => starts.length > 0);

    // A seat is driven inside the engine, so the Rust core pushed no pending-launch
    // slot for it. The marker makes the supervisor echo `council: true` onto the seat's
    // `session-started`, so the reader never runs board-FIFO correlation for the seat
    // (no desync warn, no mis-bind of a concurrently-pending board task).
    expect(starts.length).toBeGreaterThan(0);
    for (const start of starts) {
      expect(start.council).toBe(true);
    }
  });
});
