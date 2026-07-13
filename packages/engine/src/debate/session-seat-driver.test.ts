/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { NightcoreEvent, TokenUsage } from '@nightcore/contracts';

import type { SeatContext, SeatTurnRequest } from './conductor-types.js';
import {
  type SeatSessionBackend,
  type SeatSessionParams,
  SessionSeatDriver,
} from './session-seat-driver.js';

const USAGE: TokenUsage = {
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningOutputTokens: 0,
};

const SEAT: SeatContext = {
  seatId: 'proposer-opus',
  role: 'proposer',
  model: 'claude-opus-4-8',
};

/** A deterministic in-memory engine backend: `spawn` hands out monotonic ids; `emit`
 *  fans a synthetic event to subscribers. */
class FakeBackend implements SeatSessionBackend {
  private nextId = 1;
  private readonly listeners = new Set<(event: NightcoreEvent) => void>();
  readonly spawns: SeatSessionParams[] = [];

  spawn(params: SeatSessionParams): number {
    this.spawns.push(params);
    return this.nextId++;
  }

  on(listener: (event: NightcoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: NightcoreEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

function completed(sessionId: number, result: string): NightcoreEvent {
  return {
    type: 'session-completed',
    sessionId,
    result,
    costUsd: 0.5,
    numTurns: 1,
    durationMs: 0,
    usage: USAGE,
  };
}

function failed(sessionId: number): NightcoreEvent {
  return {
    type: 'session-failed',
    sessionId,
    reason: 'runner-crash',
    message: 'boom',
  };
}

function request(signal: AbortSignal): SeatTurnRequest {
  return { seat: SEAT, stage: 'propose', prompt: 'propose your answer', signal };
}

describe('SessionSeatDriver', () => {
  test('spawns a research-model session and resolves on that session’s completion', async () => {
    const backend = new FakeBackend();
    const driver = new SessionSeatDriver({ backend });
    const controller = new AbortController();

    const pending = driver.runTurn(request(controller.signal));
    // The seat spawned exactly one session with its own model + prompt.
    expect(backend.spawns).toEqual([
      { prompt: 'propose your answer', model: 'claude-opus-4-8' },
    ]);

    backend.emit(completed(1, 'my proposal'));
    const result = await pending;

    expect(result.content).toBe('my proposal');
    expect(result.usage).toEqual(USAGE);
    expect(result.costUsd).toBe(0.5);
    // The subscription is torn down after the turn settles (no listener leak).
    expect(backend.listenerCount).toBe(0);
  });

  test('ignores events from OTHER sessions (race-free correlation by exact id)', async () => {
    const backend = new FakeBackend();
    const driver = new SessionSeatDriver({ backend });
    const controller = new AbortController();

    const pending = driver.runTurn(request(controller.signal)); // session id 1
    // A concurrent, unrelated session's completion must not settle this turn.
    backend.emit(completed(99, 'someone else'));
    backend.emit(completed(1, 'the right one'));

    expect((await pending).content).toBe('the right one');
  });

  test('a failed seat session degrades to an EMPTY turn (never rejects)', async () => {
    const backend = new FakeBackend();
    const driver = new SessionSeatDriver({ backend });
    const controller = new AbortController();

    const pending = driver.runTurn(request(controller.signal));
    backend.emit(failed(1));
    const result = await pending;

    expect(result.content).toBe('');
    expect(result.costUsd).toBe(0);
    expect(result.usage.inputTokens).toBe(0);
    expect(backend.listenerCount).toBe(0);
  });

  test('an already-aborted signal returns an empty turn without spawning', async () => {
    const backend = new FakeBackend();
    const driver = new SessionSeatDriver({ backend });
    const controller = new AbortController();
    controller.abort();

    const result = await driver.runTurn(request(controller.signal));
    expect(result.content).toBe('');
    expect(backend.spawns).toHaveLength(0);
  });

  test('an abort mid-flight settles the turn empty and unsubscribes', async () => {
    const backend = new FakeBackend();
    const driver = new SessionSeatDriver({ backend });
    const controller = new AbortController();

    const pending = driver.runTurn(request(controller.signal));
    expect(backend.listenerCount).toBe(1);
    controller.abort();
    const result = await pending;

    expect(result.content).toBe('');
    expect(backend.listenerCount).toBe(0);
  });

  // ── LOW-B (#351): teardown on a synchronous hard throw ──────────────────────

  test('a synchronous spawn throw tears down (unsubscribes) and degrades to an empty turn', async () => {
    // An UNEXPECTED hard error thrown synchronously inside the Promise executor (not one
    // of the two refusals converted upstream) must still remove the abort listener AND
    // unsubscribe — pre-#351 it leaked the subscription while the run degraded.
    class SpawnThrowsBackend implements SeatSessionBackend {
      private readonly listeners = new Set<(event: NightcoreEvent) => void>();
      spawn(): number {
        throw new Error('spawn boom');
      }
      on(listener: (event: NightcoreEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }
      get listenerCount(): number {
        return this.listeners.size;
      }
    }

    const backend = new SpawnThrowsBackend();
    const driver = new SessionSeatDriver({ backend });
    const controller = new AbortController();

    // Resolves (does NOT reject) with an empty turn...
    const result = await driver.runTurn(request(controller.signal));
    expect(result.content).toBe('');
    expect(result.costUsd).toBe(0);
    // ...and the subscription registered before the throw is torn down (no leak).
    expect(backend.listenerCount).toBe(0);

    // A late abort after the hard-throw teardown is an inert no-op (already settled).
    expect(() => controller.abort()).not.toThrow();
  });

  test('a synchronous subscription throw also degrades to an empty turn without leaking', async () => {
    class OnThrowsBackend implements SeatSessionBackend {
      spawnCount = 0;
      spawn(): number {
        this.spawnCount += 1;
        return 1;
      }
      on(): () => void {
        throw new Error('subscribe boom');
      }
    }

    const backend = new OnThrowsBackend();
    const driver = new SessionSeatDriver({ backend });
    const controller = new AbortController();

    const result = await driver.runTurn(request(controller.signal));
    expect(result.content).toBe('');
    // The subscription threw before spawning, so no session was ever started.
    expect(backend.spawnCount).toBe(0);
  });
});
