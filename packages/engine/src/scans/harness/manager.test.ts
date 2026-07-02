/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  type Config,
  ConfigSchema,
  type ConventionCategory,
  type NightcoreEvent,
  type SurfaceCommand,
} from '@nightcore/contracts';

import type { SessionRunnerConfig } from '../../session/session-runner.js';
import { HarnessManager, type HarnessRunnerFactory } from './manager.js';

type StartHarnessScan = Extract<SurfaceCommand, { type: 'start-harness-scan' }>;

/**
 * Drive the `HarnessManager` orchestrator with a FAKE runner injected via the
 * `runnerFactory` dep — no SDK, no subprocess. The same fake serves BOTH roles:
 * a convention pass (routed by its lens persona) returns a canned findings array,
 * and the single synthesis pass (routed by its "SYNTHESIZING" persona) returns a
 * canned artifacts array. This exercises the profile → fan-out → ground → dedup →
 * synthesize → complete flow and the cancel path in isolation.
 */

const BASE_CONFIG: Config = ConfigSchema.parse({
  paths: { home: '/tmp/nc-home', sessions: '/tmp/nc-home/sessions' },
});

function startCommand(
  categories: ConventionCategory[],
  over: Partial<{ runId: string; maxConcurrency: number }> = {},
): StartHarnessScan {
  return {
    type: 'start-harness-scan',
    runId: over.runId ?? 'run-1',
    projectPath: '/proj',
    categories,
    ...(over.maxConcurrency !== undefined
      ? { maxConcurrency: over.maxConcurrency }
      : {}),
  };
}

/** Resolves once the manager emits a terminal `harness-scan-completed`/`-failed`. */
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
    if (
      event.type === 'harness-scan-completed' ||
      event.type === 'harness-scan-failed'
    ) {
      resolve(events);
    }
  };
  return { events, emit, done };
}

/** Emit a `session-completed` carrying `result`, then resolve. */
function completing(
  result: string,
  costUsd = 0,
): (emit: (e: NightcoreEvent) => void) => Promise<void> {
  return async (emit) => {
    emit({
      type: 'session-completed',
      sessionId: -1,
      result,
      costUsd,
      numTurns: 1,
      durationMs: 1,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
  };
}

/** A fileless convention finding (survives grounding even when projectPath is fake). */
const ONE_FINDING = JSON.stringify([
  {
    kind: 'convention',
    severity: 'medium',
    title: 'Folder-per-component',
    description: 'each component lives in its own folder',
  },
]);

/** One eslint-config artifact (relative path + non-empty content → survives grounding). */
const ONE_ARTIFACT = JSON.stringify([
  {
    kind: 'eslint-config',
    title: 'Flat config with the harness rules',
    description: 'wires the generated rules',
    targetPath: 'eslint.config.js',
    writeMode: 'create',
    content: 'export default [];\n',
    sourceFindings: [],
  },
]);

/** Route the canned response by persona: synthesis vs. a convention lens. */
function cannedFactory(): HarnessRunnerFactory {
  return (cfg: SessionRunnerConfig, emit) => ({
    async run() {
      const isSynthesis = cfg.appendSystemPrompt?.includes('SYNTHESIZING') ?? false;
      await completing(isSynthesis ? ONE_ARTIFACT : ONE_FINDING)(emit);
    },
    async interrupt() {},
  });
}

describe('HarnessManager — event ordering', () => {
  test('emits scan-started → profile-ready → category-* → synthesis-started → proposals-ready → scan-completed', async () => {
    const { emit, done } = collect();
    const manager = new HarnessManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: cannedFactory(),
    });

    manager.start(startCommand(['architecture']));
    const events = await done;
    const types = events.map((e) => e.type);

    expect(types[0]).toBe('harness-scan-started');
    expect(types[1]).toBe('harness-profile-ready');
    expect(types[types.length - 1]).toBe('harness-scan-completed');

    const catStarted = types.indexOf('harness-category-started');
    const catCompleted = types.indexOf('harness-category-completed');
    const synthesisStarted = types.indexOf('harness-synthesis-started');
    const proposals = types.indexOf('harness-proposals-ready');
    expect(catStarted).toBeGreaterThan(1);
    expect(catCompleted).toBeGreaterThan(catStarted);
    // synthesis-started lands after every lens completes and before proposals — it
    // is what swaps the UI's all-lenses-done dead zone for "Synthesizing harness…".
    expect(synthesisStarted).toBeGreaterThan(catCompleted);
    expect(proposals).toBeGreaterThan(synthesisStarted);
    expect(proposals).toBeLessThan(types.length - 1);

    const completed = events.find((e) => e.type === 'harness-scan-completed');
    if (completed?.type !== 'harness-scan-completed') throw new Error('no completed');
    expect(completed.findings).toHaveLength(1);
    expect(completed.artifacts).toHaveLength(1);
    expect(completed.artifacts[0]?.targetPath).toBe('eslint.config.js');
    expect(completed.categoriesRun).toEqual(['architecture']);
  });
});

describe('HarnessManager — per-category fan-out', () => {
  test('runs every requested lens and emits one completed per lens', async () => {
    const { events, emit, done } = collect();
    const manager = new HarnessManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: cannedFactory(),
    });

    manager.start(
      startCommand(['architecture', 'naming', 'testing'], { maxConcurrency: 2 }),
    );
    await done;

    const completedLenses = events
      .filter((e) => e.type === 'harness-category-completed')
      .map((e) => (e.type === 'harness-category-completed' ? e.category : ''));
    expect(completedLenses.sort()).toEqual(['architecture', 'naming', 'testing']);
  });
});

describe('HarnessManager — corrective retry', () => {
  test('a non-JSON-then-JSON lens triggers exactly ONE corrective retry', async () => {
    let lensCalls = 0;
    const factory: HarnessRunnerFactory = (cfg: SessionRunnerConfig, emit) => ({
      async run() {
        if (cfg.appendSystemPrompt?.includes('SYNTHESIZING')) {
          await completing(ONE_ARTIFACT)(emit);
          return;
        }
        lensCalls++;
        const isRetry = cfg.prompt.includes('was not valid JSON');
        await completing(isRetry ? ONE_FINDING : 'sorry, prose not json')(emit);
      },
      async interrupt() {},
    });

    const { emit, done } = collect();
    const manager = new HarnessManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['naming']));
    const events = await done;

    expect(lensCalls).toBe(2); // one original + one retry
    const completed = events.find((e) => e.type === 'harness-scan-completed');
    expect(
      completed?.type === 'harness-scan-completed' && completed.findings,
    ).toHaveLength(1);
  });
});

describe('HarnessManager — synthesis failure degrades', () => {
  test('a synthesis with no JSON still completes with empty artifacts', async () => {
    const factory: HarnessRunnerFactory = (cfg: SessionRunnerConfig, emit) => ({
      async run() {
        const isSynthesis = cfg.appendSystemPrompt?.includes('SYNTHESIZING');
        await completing(isSynthesis ? 'no artifacts, sorry' : ONE_FINDING)(emit);
      },
      async interrupt() {},
    });

    const { emit, done } = collect();
    const manager = new HarnessManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['architecture']));
    const events = await done;
    const completed = events.find((e) => e.type === 'harness-scan-completed');
    expect(completed?.type === 'harness-scan-completed' && completed.artifacts).toEqual(
      [],
    );
  });
});

describe('HarnessManager — cancellation', () => {
  test('cancel interrupts live passes and surfaces reason "aborted"', async () => {
    const live: Array<() => void> = [];
    const factory: HarnessRunnerFactory = (_cfg, emit) => {
      let abort!: () => void;
      const parked = new Promise<void>((r) => {
        abort = r;
      });
      return {
        async run() {
          live.push(abort);
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
    const manager = new HarnessManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['architecture', 'naming']));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(live.length).toBeGreaterThan(0);
    manager.cancel('run-1');

    const events = await done;
    const failed = events.find((e) => e.type === 'harness-scan-failed');
    expect(failed).toBeDefined();
    expect(failed?.type === 'harness-scan-failed' && failed.reason).toBe('aborted');
    // The profile is deterministic, so it still lands before the abort.
    expect(events.some((e) => e.type === 'harness-profile-ready')).toBe(true);
  });
});

describe('HarnessManager — duplicate start', () => {
  test('a duplicate-runId start() is ignored', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const factory: HarnessRunnerFactory = (cfg: SessionRunnerConfig, emit) => ({
      async run() {
        if (!cfg.appendSystemPrompt?.includes('SYNTHESIZING')) await gate;
        const isSynthesis = cfg.appendSystemPrompt?.includes('SYNTHESIZING');
        await completing(isSynthesis ? ONE_ARTIFACT : ONE_FINDING)(emit);
      },
      async interrupt() {},
    });

    const { events, emit, done } = collect();
    const manager = new HarnessManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['architecture'], { runId: 'dup' }));
    manager.start(startCommand(['naming'], { runId: 'dup' }));
    release();
    await done;

    const starts = events.filter((e) => e.type === 'harness-scan-started');
    expect(starts).toHaveLength(1);
    const catStarts = events.filter((e) => e.type === 'harness-category-started');
    expect(catStarts).toHaveLength(1);
  });
});
