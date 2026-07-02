/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  type Config,
  ConfigSchema,
  type NightcoreEvent,
  type ScorecardDimension,
  type SurfaceCommand,
} from '@nightcore/contracts';

import {
  ScorecardManager,
  type ScorecardRunnerFactory,
} from './manager.js';

type StartScorecard = Extract<SurfaceCommand, { type: 'start-scorecard' }>;

/**
 * Drive the `ScorecardManager` orchestrator with a FAKE runner injected via the
 * `runnerFactory` dep — no SDK, no subprocess (the twin of `analysis-manager.test`).
 * Each fake emits scripted `session-completed` / `session-failed` events so the
 * manager's pooling, retry, accumulation, cancellation, and event ordering are
 * exercised in isolation.
 */

const BASE_CONFIG: Config = ConfigSchema.parse({
  paths: { home: '/tmp/nc-home', sessions: '/tmp/nc-home/sessions' },
});

function startCommand(
  dimensions: ScorecardDimension[],
  over: Partial<{ runId: string; maxConcurrency: number }> = {},
): StartScorecard {
  return {
    type: 'start-scorecard',
    runId: over.runId ?? 'run-1',
    projectPath: '/proj',
    dimensions,
    ...(over.maxConcurrency !== undefined
      ? { maxConcurrency: over.maxConcurrency }
      : {}),
  };
}

function collect(): {
  events: NightcoreEvent[];
  emit: (event: NightcoreEvent) => void;
  done: Promise<NightcoreEvent[]>;
} {
  const events: NightcoreEvent[] = [];
  let resolve!: (value: NightcoreEvent[]) => void;
  const done = new Promise<NightcoreEvent[]>((r) => {
    resolve = r;
  });
  const emit = (event: NightcoreEvent): void => {
    events.push(event);
    if (event.type === 'scorecard-completed' || event.type === 'scorecard-failed') {
      resolve(events);
    }
  };
  return { events, emit, done };
}

function completing(
  result: string,
  costUsd = 0,
  usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
): (emit: (e: NightcoreEvent) => void) => Promise<void> {
  return async (emit) => {
    emit({
      type: 'session-completed',
      sessionId: -1,
      result,
      costUsd,
      numTurns: 1,
      durationMs: 1,
      usage,
    });
  };
}

const ONE_READING = JSON.stringify({
  grade: 'B',
  title: 'Reading',
  summary: 'graded summary',
});

describe('ScorecardManager — concurrency cap', () => {
  test('runs at most maxConcurrency dimension passes at once', async () => {
    const CAP = 2;
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const factory: ScorecardRunnerFactory = (_cfg, emit) => ({
      async run() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        if (inFlight >= CAP) release();
        await gate;
        await completing(ONE_READING)(emit);
        inFlight--;
      },
      async interrupt() {},
    });

    const { emit, done } = collect();
    const manager = new ScorecardManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(
      startCommand(['architecture', 'tests', 'security', 'performance'], {
        maxConcurrency: CAP,
      }),
    );
    await done;
    expect(peak).toBe(CAP);
  });
});

describe('ScorecardManager — cancellation', () => {
  test('cancel interrupts live runners and surfaces reason "aborted"', async () => {
    const live: Array<{ resolve: () => void }> = [];
    const factory: ScorecardRunnerFactory = (_cfg, emit) => {
      let abort!: () => void;
      const parked = new Promise<void>((r) => {
        abort = r;
      });
      return {
        async run() {
          live.push({ resolve: abort });
          await parked;
          emit({
            type: 'session-failed',
            sessionId: -1,
            reason: 'aborted',
            message: 'interrupted',
          });
        },
        async interrupt() {
          abort();
        },
      };
    };

    const { emit, done } = collect();
    const manager = new ScorecardManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['architecture', 'security']));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(live.length).toBeGreaterThan(0);
    manager.cancel('run-1');

    const events = await done;
    const failed = events.find((e) => e.type === 'scorecard-failed');
    expect(failed?.type === 'scorecard-failed' && failed.reason).toBe('aborted');
  });
});

describe('ScorecardManager — corrective retry', () => {
  test('a non-JSON-then-JSON pass triggers exactly ONE corrective retry', async () => {
    let calls = 0;
    const factory: ScorecardRunnerFactory = (cfg, emit) => ({
      async run() {
        calls++;
        const isRetry = cfg.prompt.includes('was not valid JSON');
        await completing(isRetry ? ONE_READING : 'prose, no json')(emit);
      },
      async interrupt() {},
    });

    const { emit, done } = collect();
    const manager = new ScorecardManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['security']));
    const events = await done;
    expect(calls).toBe(2);
    const completed = events.find((e) => e.type === 'scorecard-completed');
    expect(
      completed?.type === 'scorecard-completed' && completed.readings,
    ).toHaveLength(1);
  });
});

describe('ScorecardManager — event ordering', () => {
  test('emits scorecard-started → dimension-* → scorecard-completed in order', async () => {
    const factory: ScorecardRunnerFactory = (_cfg, emit) => ({
      async run() {
        await completing(ONE_READING)(emit);
      },
      async interrupt() {},
    });

    const { emit, done } = collect();
    const manager = new ScorecardManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['tests']));
    const events = await done;
    const types = events.map((e) => e.type);

    expect(types[0]).toBe('scorecard-started');
    expect(types[types.length - 1]).toBe('scorecard-completed');
    const startedAt = types.indexOf('scorecard-dimension-started');
    const completedAt = types.indexOf('scorecard-dimension-completed');
    expect(startedAt).toBeGreaterThan(0);
    expect(completedAt).toBeGreaterThan(startedAt);
    expect(completedAt).toBeLessThan(types.length - 1);

    // The completed dimension event carries the graded reading.
    const dimDone = events.find((e) => e.type === 'scorecard-dimension-completed');
    expect(
      dimDone?.type === 'scorecard-dimension-completed' &&
        dimDone.reading?.grade,
    ).toBe('B');
  });
});
