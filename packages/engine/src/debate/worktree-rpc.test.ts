/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { NightcoreEvent } from '@nightcore/contracts';

import { WorktreeOpBroker } from './worktree-rpc.js';

/** Capture every emitted event so a test can assert the request wire shape + drive replies. */
function capturingBroker(overrides: { requestTimeoutMs?: number } = {}): {
  broker: WorktreeOpBroker;
  events: NightcoreEvent[];
} {
  const events: NightcoreEvent[] = [];
  const broker = new WorktreeOpBroker({
    emit: (event) => events.push(event),
    ...(overrides.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: overrides.requestTimeoutMs }
      : {}),
  });
  return { broker, events };
}

describe('WorktreeOpBroker', () => {
  test('a request emits a PATH-LESS worktree-op-required event and resolves on the matching reply', async () => {
    const { broker, events } = capturingBroker();
    const pending = broker.request('allocate', 'run-1', new AbortController().signal);

    // Exactly one event, and it carries ONLY the verb + the run id — NO path. This is the
    // whole security posture: the engine names an op + a run, never a filesystem path.
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe('worktree-op-required');
    if (event.type !== 'worktree-op-required') throw new Error('unreachable');
    expect(event.op).toBe('allocate');
    expect(event.councilRunId).toBe('run-1');
    expect(Object.keys(event).sort()).toEqual(['councilRunId', 'op', 'requestId', 'type']);
    // Nothing that looks like a path can be smuggled onto the request.
    expect(JSON.stringify(event)).not.toContain('/');

    // The host replies for THIS requestId → the awaiting call resolves with the reply.
    expect(broker.resolve(event.requestId, { worktreePath: '/proj/.nightcore/worktrees/run-1' })).toBe(
      true,
    );
    expect(await pending).toEqual({ worktreePath: '/proj/.nightcore/worktrees/run-1' });
  });

  test('resolve returns false for an unknown / already-settled requestId (a stale reply)', () => {
    const { broker } = capturingBroker();
    expect(broker.resolve('never-issued', { error: 'x' })).toBe(false);
  });

  test('an abort mid-flight settles the request CLOSED (error), never hangs', async () => {
    const { broker } = capturingBroker();
    const controller = new AbortController();
    const pending = broker.request('gauntlet', 'run-2', controller.signal);
    controller.abort();
    const reply = await pending;
    expect(reply.error).toBeDefined();
    expect(reply.gauntletPassed).toBeUndefined();
    // A late host reply for the aborted request is a no-op (already settled).
    // (requestId is internal, so this just asserts no throw / no second settle path.)
  });

  test('an already-aborted signal resolves immediately with an error and never emits', () => {
    const { broker, events } = capturingBroker();
    const controller = new AbortController();
    controller.abort();
    const pending = broker.request('commit', 'run-3', controller.signal);
    expect(events).toHaveLength(0);
    return expect(pending).resolves.toHaveProperty('error');
  });

  test('a reply timeout settles the request CLOSED rather than leaking a pending entry', async () => {
    const { broker } = capturingBroker({ requestTimeoutMs: 5 });
    const reply = await broker.request('allocate', 'run-4', new AbortController().signal);
    expect(reply.error).toContain('timed out');
    // The pending entry was evicted on timeout — a late reply resolves nothing.
  });
});
