/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  type Config,
  ConfigSchema,
  type FindingCategory,
  type NightcoreEvent,
  type SurfaceCommand,
} from '@nightcore/contracts';

import type { SessionRunnerConfig } from '../../session/session-runner.js';
import {
  AnalysisManager,
  type AnalysisRunnerFactory,
} from './manager.js';

type StartAnalysis = Extract<SurfaceCommand, { type: 'start-analysis' }>;

/**
 * Drive the `AnalysisManager` orchestrator with a FAKE runner injected via the
 * `runnerFactory` dep — no SDK, no subprocess. Each fake emits scripted
 * `session-completed` / `session-failed` events through the `emit` callback it is
 * handed, exactly as the real `SessionRunner` would, so the manager's pooling,
 * retry, accumulation, cancellation, and event ordering are all exercised in
 * isolation.
 */

const BASE_CONFIG: Config = ConfigSchema.parse({
  paths: { home: '/tmp/nc-home', sessions: '/tmp/nc-home/sessions' },
});

/** A valid `start-analysis` command for the given categories. */
function startCommand(
  categories: FindingCategory[],
  over: Partial<{
    runId: string;
    maxConcurrency: number;
  }> = {},
): StartAnalysis {
  return {
    type: 'start-analysis',
    runId: over.runId ?? 'run-1',
    projectPath: '/proj',
    scope: 'repo',
    categories,
    ...(over.maxConcurrency !== undefined
      ? { maxConcurrency: over.maxConcurrency }
      : {}),
  };
}

/** A finished `analysis-completed` event awaited as a promise: resolves once the
 *  manager emits a terminal `analysis-completed` or `analysis-failed`. */
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
    if (event.type === 'analysis-completed' || event.type === 'analysis-failed') {
      resolve(events);
    }
  };
  return { events, emit, done };
}

/** Emit a `session-completed` carrying `result` + usage/cost, then resolve. */
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

const ONE_FINDING = JSON.stringify([
  { severity: 'high', effort: 'small', title: 'Issue', description: 'desc' },
]);

describe('AnalysisManager — concurrency cap', () => {
  test('runs at most maxConcurrency category passes at once', async () => {
    const CAP = 2;
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const factory: AnalysisRunnerFactory = (_cfg, emit) => ({
      async run() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // Once the pool has saturated the cap, peak is proven — open the gate so
        // every runner can drain (the later passes still pass through the same cap
        // as earlier ones complete).
        if (inFlight >= CAP) release();
        await gate;
        await completing(ONE_FINDING)(emit);
        inFlight--;
      },
      async interrupt() {},
    });

    const { emit, done } = collect();
    const manager = new AnalysisManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(
      startCommand(['bugs', 'security', 'refactor', 'performance'], {
        maxConcurrency: CAP,
      }),
    );
    await done;
    expect(peak).toBe(CAP);
  });

  test('defaults to 6-way concurrency when no maxConcurrency override is given', async () => {
    // With 8 categories and no override the pool saturates at the default of 6
    // (runPool caps at categories.length, here 8). The gate releases
    // only once 6 are in flight, so this hangs/fails if the default regresses below 6.
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const factory: AnalysisRunnerFactory = (_cfg, emit) => ({
      async run() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        if (peak >= 6) release();
        await gate;
        await completing(ONE_FINDING)(emit);
        inFlight--;
      },
      async interrupt() {},
    });

    const { emit, done } = collect();
    const manager = new AnalysisManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(
      startCommand([
        'architecture',
        'bugs',
        'refactor',
        'performance',
        'security',
        'tests',
        'docs',
        'ui-ux',
      ]),
    );
    await done;
    expect(peak).toBe(6);
  });
});

describe('AnalysisManager — cancellation', () => {
  test('cancel interrupts live runners and surfaces reason "aborted"', async () => {
    const live: Array<{ resolve: () => void; emit: (e: NightcoreEvent) => void }> =
      [];

    const factory: AnalysisRunnerFactory = (_cfg, emit) => {
      let abort!: () => void;
      const parked = new Promise<void>((r) => {
        abort = r;
      });
      return {
        async run() {
          // Park until interrupted; then emit an aborted failure like the real
          // runner would when its query is interrupted.
          live.push({ resolve: abort, emit });
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
    const manager = new AnalysisManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['bugs', 'security']));
    // Let the pool spin up its runners, then cancel.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(live.length).toBeGreaterThan(0);
    manager.cancel('run-1');

    const events = await done;
    const failed = events.find((e) => e.type === 'analysis-failed');
    expect(failed).toBeDefined();
    expect(failed?.type === 'analysis-failed' && failed.reason).toBe('aborted');
  });
});

describe('AnalysisManager — corrective retry', () => {
  test('a non-JSON-then-JSON pass triggers exactly ONE corrective retry', async () => {
    let calls = 0;
    const prompts: string[] = [];

    const factory: AnalysisRunnerFactory = (
      cfg: SessionRunnerConfig,
      emit,
    ) => ({
      async run() {
        calls++;
        prompts.push(cfg.prompt);
        // First call: prose (no JSON). Retry call: valid JSON.
        const isRetry = cfg.prompt.includes('was not valid JSON');
        await completing(isRetry ? ONE_FINDING : 'sorry, here is some prose')(
          emit,
        );
      },
      async interrupt() {},
    });

    const { emit, done } = collect();
    const manager = new AnalysisManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['bugs']));
    const events = await done;

    // Exactly one original + one retry = two runner runs for the single category.
    expect(calls).toBe(2);
    expect(prompts.filter((p) => p.includes('was not valid JSON'))).toHaveLength(
      1,
    );

    const completed = events.find((e) => e.type === 'analysis-completed');
    expect(completed?.type === 'analysis-completed' && completed.findings).toHaveLength(
      1,
    );
  });
});

describe('AnalysisManager — usage/cost accumulation', () => {
  test('sums usage and cost across categories', async () => {
    const factory: AnalysisRunnerFactory = (_cfg, emit) => ({
      async run() {
        await completing(ONE_FINDING, 0.25, {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 5,
          cacheCreationTokens: 1,
        })(emit);
      },
      async interrupt() {},
    });

    const { emit, done } = collect();
    const manager = new AnalysisManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['bugs', 'security', 'refactor']));
    const events = await done;
    const completed = events.find((e) => e.type === 'analysis-completed');
    if (completed?.type !== 'analysis-completed') throw new Error('no completed');

    expect(completed.costUsd).toBeCloseTo(0.75, 6); // 3 × 0.25
    expect(completed.usage).toEqual({
      inputTokens: 300,
      outputTokens: 60,
      cacheReadTokens: 15,
      cacheCreationTokens: 3,
    });
  });
});

describe('AnalysisManager — duplicate start', () => {
  test('a duplicate-runId start() is ignored', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const factory: AnalysisRunnerFactory = (_cfg, emit) => ({
      async run() {
        await gate;
        await completing(ONE_FINDING)(emit);
      },
      async interrupt() {},
    });

    const { events, emit, done } = collect();
    const manager = new AnalysisManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['bugs'], { runId: 'dup' }));
    // Second start with the SAME runId while the first is still active: ignored.
    manager.start(startCommand(['security'], { runId: 'dup' }));
    release();
    await done;

    const starts = events.filter((e) => e.type === 'analysis-started');
    expect(starts).toHaveLength(1);
    // The second command's category ('security') never ran.
    const catStarts = events.filter(
      (e) => e.type === 'analysis-category-started',
    );
    expect(catStarts).toHaveLength(1);
    expect(
      catStarts[0]?.type === 'analysis-category-started' &&
        catStarts[0].category,
    ).toBe('bugs');
  });
});

describe('AnalysisManager — event ordering', () => {
  test('emits analysis-started → category-* → analysis-completed in order', async () => {
    const factory: AnalysisRunnerFactory = (_cfg, emit) => ({
      async run() {
        await completing(ONE_FINDING)(emit);
      },
      async interrupt() {},
    });

    const { emit, done } = collect();
    const manager = new AnalysisManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['bugs']));
    const events = await done;
    const types = events.map((e) => e.type);

    expect(types[0]).toBe('analysis-started');
    expect(types[types.length - 1]).toBe('analysis-completed');
    // A category's started precedes its completed.
    const startedAt = types.indexOf('analysis-category-started');
    const completedAt = types.indexOf('analysis-category-completed');
    expect(startedAt).toBeGreaterThan(0);
    expect(completedAt).toBeGreaterThan(startedAt);
    expect(completedAt).toBeLessThan(types.length - 1);
  });
});
