/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { CouncilBudget, TokenUsage } from '@nightcore/contracts';

import {
  type BroadcastClock,
  collectBroadcast,
} from './broadcast-collector.js';
import { RunGovernor } from './conductor-budget.js';
import type { SeatTurnResult, TurnEstimate } from './conductor-types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OPEN_BUDGET: CouncilBudget = {
  maxRounds: 5,
  maxTotalTokens: 1_000_000_000,
  maxCostUsd: 1_000_000_000,
};

const NO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningOutputTokens: 0,
};

const EMPTY: SeatTurnResult = { content: '', usage: NO_USAGE, costUsd: 0 };

function seat(seatId: string): { seatId: string } {
  return { seatId };
}

function tokens(inputTokens: number): SeatTurnResult {
  return {
    content: `spent-${inputTokens}`,
    usage: { ...NO_USAGE, inputTokens },
    costUsd: 0,
  };
}

/** A manual timer seam: pending handlers fire only when the test calls `fireAll`. */
function manualClock(): { clock: BroadcastClock; fireAll: () => void } {
  const pending = new Set<() => void>();
  const clock: BroadcastClock = (handler) => {
    pending.add(handler);
    return () => pending.delete(handler);
  };
  return {
    clock,
    fireAll: () => {
      for (const handler of [...pending]) {
        pending.delete(handler);
        handler();
      }
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ── Tagging ─────────────────────────────────────────────────────────────────

describe('collectBroadcast — tags each reply with the shared broadcastId + per-seat seq', () => {
  test('every outcome carries the broadcastId and its 0-based seat seq, in seat order', async () => {
    const seats = [seat('a'), seat('b'), seat('c')];
    const governor = new RunGovernor(OPEN_BUDGET);

    const result = await collectBroadcast({
      broadcastId: 'bc-42',
      seats,
      governor,
      run: (s) => Promise.resolve({ ...EMPTY, content: `reply-${s.seatId}` }),
    });

    expect(result.broadcastId).toBe('bc-42');
    expect(result.outcomes.map((o) => o.seq)).toEqual([0, 1, 2]);
    expect(result.outcomes.map((o) => o.seat.seatId)).toEqual(['a', 'b', 'c']);
    expect(result.outcomes.every((o) => o.broadcastId === 'bc-42')).toBe(true);
    expect(result.outcomes.map((o) => o.status)).toEqual([
      'responded',
      'responded',
      'responded',
    ]);
    expect(result.responders.map((o) => o.result?.content)).toEqual([
      'reply-a',
      'reply-b',
      'reply-c',
    ]);
  });
});

// ── Quorum ────────────────────────────────────────────────────────────────────

describe('collectBroadcast — resolves on QUORUM without the slow seat', () => {
  test('quorum responders resolve the broadcast; the straggler is aborted + timed-out', async () => {
    const seats = [seat('a'), seat('b'), seat('c')];
    const governor = new RunGovernor(OPEN_BUDGET);
    let slowAborted = false;

    // c never answers on its own; only the quorum-driven abort settles it. A LONG
    // timeout proves QUORUM (not the timeout) is what resolves the board.
    const result = await collectBroadcast({
      broadcastId: 'bc',
      seats,
      governor,
      quorum: 2,
      timeoutMs: 10_000,
      run: (s, dispatch) => {
        if (s.seatId !== 'c') {
          return Promise.resolve({ ...EMPTY, content: `reply-${s.seatId}` });
        }
        return new Promise<SeatTurnResult>((resolve) => {
          dispatch.signal.addEventListener('abort', () => {
            slowAborted = true;
            resolve(EMPTY);
          });
        });
      },
    });

    expect(result.responders.map((o) => o.seat.seatId).sort()).toEqual(['a', 'b']);
    expect(result.outcomes.find((o) => o.seat.seatId === 'c')?.status).toBe(
      'timed-out',
    );
    expect(slowAborted).toBe(true);
  });
});

// ── Timeout ─────────────────────────────────────────────────────────────────

describe('collectBroadcast — a per-seat TIMEOUT keeps a hung seat from stalling the board', () => {
  test('seats that never resolve (and ignore abort) still settle timed-out on timeout', async () => {
    const seats = [seat('a'), seat('b'), seat('c')];
    const governor = new RunGovernor(OPEN_BUDGET);
    const { clock, fireAll } = manualClock();

    // Every seat hangs forever AND ignores its abort signal — the worst case. The
    // collector must abandon the hung dispatch on timeout rather than await it.
    const pending = collectBroadcast({
      broadcastId: 'bc',
      seats,
      governor,
      timeoutMs: 50,
      clock,
      run: () => new Promise<SeatTurnResult>(() => {}),
    });

    await tick();
    fireAll();
    const result = await pending;

    expect(result.responders).toHaveLength(0);
    expect(result.outcomes.map((o) => o.status)).toEqual([
      'timed-out',
      'timed-out',
      'timed-out',
    ]);
  });

  test('a mix of responders + one hung seat resolves with just the responders', async () => {
    const seats = [seat('a'), seat('b'), seat('hung')];
    const governor = new RunGovernor(OPEN_BUDGET);
    const { clock, fireAll } = manualClock();

    const pending = collectBroadcast({
      broadcastId: 'bc',
      seats,
      governor,
      timeoutMs: 50,
      clock,
      run: (s) =>
        s.seatId === 'hung'
          ? new Promise<SeatTurnResult>(() => {})
          : Promise.resolve({ ...EMPTY, content: `reply-${s.seatId}` }),
    });

    await tick();
    fireAll();
    const result = await pending;

    expect(result.responders.map((o) => o.seat.seatId).sort()).toEqual(['a', 'b']);
    expect(result.outcomes.find((o) => o.seat.seatId === 'hung')?.status).toBe(
      'timed-out',
    );
  });
});

// ── Bounded concurrency ───────────────────────────────────────────────────────

describe('collectBroadcast — respects the bounded max-concurrency', () => {
  test('never dispatches more than maxConcurrency seats at once', async () => {
    const seats = Array.from({ length: 6 }, (_, i) => seat(`s${i}`));
    const governor = new RunGovernor(OPEN_BUDGET);
    let inFlight = 0;
    let peak = 0;

    const result = await collectBroadcast({
      broadcastId: 'bc',
      seats,
      governor,
      maxConcurrency: 2,
      run: () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return new Promise<SeatTurnResult>((resolve) => {
          setTimeout(() => {
            inFlight -= 1;
            resolve(EMPTY);
          }, 5);
        });
      },
    });

    expect(peak).toBe(2);
    expect(result.responders).toHaveLength(6);
  });
});

// ── LOW-A: no cap overshoot ───────────────────────────────────────────────────

describe('collectBroadcast — reserves budget so a parallel broadcast cannot overshoot (#351, LOW-A)', () => {
  test('once the cap is reached, further seats are REFUSED (not dispatched)', async () => {
    // Cap = 250 tokens; 5 seats each spend 100; estimate = actual. With reservation the
    // 4th/5th seats are refused (committed + reserved would breach), so spend is bounded
    // to at most the cap + one in-flight estimate — never a full 5-seat round.
    const budget: CouncilBudget = {
      maxRounds: 1,
      maxTotalTokens: 250,
      maxCostUsd: 1_000_000_000,
    };
    const governor = new RunGovernor(budget);
    const seats = Array.from({ length: 5 }, (_, i) => seat(`s${i}`));
    const estimate: TurnEstimate = { tokens: 100, costUsd: 0 };
    let dispatched = 0;

    const result = await collectBroadcast({
      broadcastId: 'bc',
      seats,
      governor,
      estimate,
      maxConcurrency: 5,
      run: () => {
        dispatched += 1;
        return Promise.resolve(tokens(100));
      },
    });

    expect(dispatched).toBe(3);
    expect(result.outcomes.filter((o) => o.status === 'refused-cap')).toHaveLength(2);
    // Bounded to cap + at most one in-flight estimate — never the full-round 500.
    expect(governor.totals.totalTokens).toBeLessThanOrEqual(250 + estimate.tokens);
  });

  test('WITHOUT a reservation, the same broadcast fires all N and overshoots a full round', async () => {
    // The contrast that motivates LOW-A: no estimate ⇒ all 5 seats fire in parallel and
    // the committed spend blows past the cap by a whole round.
    const budget: CouncilBudget = {
      maxRounds: 1,
      maxTotalTokens: 250,
      maxCostUsd: 1_000_000_000,
    };
    const governor = new RunGovernor(budget);
    const seats = Array.from({ length: 5 }, (_, i) => seat(`s${i}`));
    let dispatched = 0;

    await collectBroadcast({
      broadcastId: 'bc',
      seats,
      governor,
      maxConcurrency: 5,
      run: () => {
        dispatched += 1;
        return Promise.resolve(tokens(100));
      },
    });

    expect(dispatched).toBe(5);
    expect(governor.totals.totalTokens).toBe(500);
  });

  test('a settled reservation nets exactly the turn’s actual spend', async () => {
    const budget: CouncilBudget = {
      maxRounds: 1,
      maxTotalTokens: 1_000,
      maxCostUsd: 1_000_000_000,
    };
    const governor = new RunGovernor(budget);
    const seats = [seat('a'), seat('b')];

    await collectBroadcast({
      broadcastId: 'bc',
      seats,
      governor,
      // A large estimate is reserved pre-dispatch but reconciled to the small actual.
      estimate: { tokens: 400, costUsd: 0 },
      run: () => Promise.resolve(tokens(10)),
    });

    // Net committed is the sum of ACTUALS (2 × 10), not the estimates — and no residual
    // reservation blocks a follow-up dispatch.
    expect(governor.totals.totalTokens).toBe(20);
    expect(governor.capBreached()).toBeNull();
  });
});

// ── Kill ──────────────────────────────────────────────────────────────────────

describe('collectBroadcast — the kill AbortSignal aborts in-flight dispatches promptly', () => {
  test('a kill mid-flight aborts the running seat and refuses the rest', async () => {
    const governor = new RunGovernor(OPEN_BUDGET);
    const seats = [seat('a'), seat('b')];
    let aAborted = false;
    let bDispatched = false;

    const result = await collectBroadcast({
      broadcastId: 'bc',
      seats,
      governor,
      signal: governor.signal,
      timeoutMs: 10_000,
      run: (s, dispatch) =>
        new Promise<SeatTurnResult>((resolve) => {
          if (s.seatId === 'b') bDispatched = true;
          dispatch.signal.addEventListener('abort', () => {
            if (s.seatId === 'a') aAborted = true;
            resolve(EMPTY);
          });
          // Seat a throws the kill switch the instant it starts.
          if (s.seatId === 'a') governor.kill();
        }),
    });

    expect(governor.signal.aborted).toBe(true);
    expect(aAborted).toBe(true);
    // Seat b was never dispatched (the kill fired before its slot started).
    expect(bDispatched).toBe(false);
    expect(result.responders).toHaveLength(0);
    expect(result.outcomes.every((o) => o.status === 'timed-out')).toBe(true);
  });

  test('an already-aborted external signal dispatches nothing', async () => {
    const governor = new RunGovernor(OPEN_BUDGET);
    governor.kill();
    const seats = [seat('a'), seat('b')];
    let dispatched = 0;

    const result = await collectBroadcast({
      broadcastId: 'bc',
      seats,
      governor,
      signal: governor.signal,
      run: () => {
        dispatched += 1;
        return Promise.resolve(EMPTY);
      },
    });

    expect(dispatched).toBe(0);
    expect(result.responders).toHaveLength(0);
    expect(result.outcomes.map((o) => o.status)).toEqual(['timed-out', 'timed-out']);
  });
});

// ── Never rejects ─────────────────────────────────────────────────────────────

describe('collectBroadcast — one broken seat never rejects the whole board', () => {
  test('a dispatch that THROWS is recorded timed-out; the others still respond', async () => {
    const governor = new RunGovernor(OPEN_BUDGET);
    const seats = [seat('a'), seat('boom'), seat('c')];

    const result = await collectBroadcast({
      broadcastId: 'bc',
      seats,
      governor,
      run: (s) => {
        if (s.seatId === 'boom') return Promise.reject(new Error('seat crashed'));
        return Promise.resolve({ ...EMPTY, content: `reply-${s.seatId}` });
      },
    });

    expect(result.responders.map((o) => o.seat.seatId).sort()).toEqual(['a', 'c']);
    expect(result.outcomes.find((o) => o.seat.seatId === 'boom')?.status).toBe(
      'timed-out',
    );
  });
});
