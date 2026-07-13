/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { DebateTranscriptEntry, TokenUsage } from '@nightcore/contracts';

import { DebateBus } from './bus.js';
import type {
  SeatDriver,
  SeatTurnRequest,
  SeatTurnResult,
} from './conductor-types.js';
import { CouncilManager } from './council-manager.js';

const NO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningOutputTokens: 0,
};

/** A driver that resolves immediately with stable per-seat content (so a run reaches
 *  Converge and stops), recording every request. */
class ImmediateDriver implements SeatDriver {
  readonly requests: SeatTurnRequest[] = [];
  runTurn(request: SeatTurnRequest): Promise<SeatTurnResult> {
    this.requests.push(request);
    return Promise.resolve({
      content: `stable-${request.seat.seatId}`,
      usage: NO_USAGE,
      costUsd: 0,
    });
  }
}

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5));

describe('CouncilManager', () => {
  test('start resolves the preset, drives the Conductor, and forwards transcript entries to the emit sink', async () => {
    const driver = new ImmediateDriver();
    const bus = new DebateBus();
    const emitted: DebateTranscriptEntry[] = [];
    const manager = new CouncilManager({
      seatDriver: driver,
      bus,
      emit: (entry) => emitted.push(entry),
    });

    manager.start({
      councilRunId: 'run-1',
      presetId: 'research',
      objective: 'Pick a strategy.',
      cwd: '/proj',
    });
    await tick();

    // The Research preset ran its three seats through Propose.
    expect(driver.requests.some((r) => r.stage === 'propose')).toBe(true);
    // The run converged and parked a decision — the emit sink saw a converge note.
    expect(
      emitted.some((e) => e.stage === 'converge' && e.kind === 'note'),
    ).toBe(true);
    // The transcript is captured in the append-only store (auditable), ordered by seq.
    const transcript = bus.seatView('run-1', 'x').read();
    expect(transcript.length).toBe(emitted.length);
    expect(transcript.map((e) => e.seq)).toEqual(
      [...transcript.map((e) => e.seq)].sort((a, b) => a - b),
    );
    // The seat sessions were given the run's cwd.
    expect(driver.requests.every((r) => r.cwd === '/proj')).toBe(true);
  });

  test('a duplicate start for a still-active run is ignored', async () => {
    const driver = new ImmediateDriver();
    const emitted: DebateTranscriptEntry[] = [];
    const manager = new CouncilManager({
      seatDriver: driver,
      emit: (entry) => emitted.push(entry),
    });

    // Two synchronous starts with the SAME id: the first is still active (paused on
    // its first awaited turn) when the second fires, so the second is guarded.
    manager.start({ councilRunId: 'dup', presetId: 'research', objective: 'o' });
    manager.start({ councilRunId: 'dup', presetId: 'research', objective: 'o' });
    await tick();

    // Exactly ONE run's worth of converge notes — the duplicate never ran.
    expect(
      emitted.filter((e) => e.stage === 'converge' && e.kind === 'note'),
    ).toHaveLength(1);
  });

  test('kill for an unknown/finished run is a no-op (never throws)', () => {
    const manager = new CouncilManager({ seatDriver: new ImmediateDriver() });
    expect(() => manager.kill('nope')).not.toThrow();
  });
});
