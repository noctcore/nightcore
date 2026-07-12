/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  type Config,
  ConfigSchema,
  type DeepScanConfig,
  type NightcoreEvent,
  type ReviewLens,
  type SurfaceCommand,
} from '@nightcore/contracts';

import type { SessionRunnerConfig } from '../../session/session-runner.js';
import { MAX_DIFF_BYTES } from './diff.js';
import { reviewFingerprint } from './findings.js';
import { type PrReviewRunnerFactory,PrReviewScanManager } from './manager.js';

type StartPrReview = Extract<SurfaceCommand, { type: 'start-pr-review' }>;

/**
 * Drive the `PrReviewScanManager` with a FAKE runner injected via `runnerFactory` — no
 * SDK, no subprocess. The same fake serves BOTH roles, routed by persona: a lens pass
 * returns a canned findings array; the single validator pass (routed by its
 * "VALIDATING" persona) returns a canned drop-list. This exercises the
 * started → fan-out → diff-ground → dedup → validate → complete flow, the validator
 * fail-open, and the cancel path in isolation.
 */

const BASE_CONFIG: Config = ConfigSchema.parse({
  paths: { home: '/tmp/nc-home', sessions: '/tmp/nc-home/sessions' },
});

function startCommand(
  lenses: ReviewLens[],
  over: Partial<{ runId: string; maxConcurrency: number }> = {},
): StartPrReview {
  return {
    type: 'start-pr-review',
    runId: over.runId ?? 'run-1',
    projectPath: '/proj',
    prNumber: 42,
    diff: 'diff --git a/src/a.ts b/src/a.ts\n@@\n+ oops();',
    changedFiles: ['src/a.ts'],
    lenses,
    ...(over.maxConcurrency !== undefined
      ? { maxConcurrency: over.maxConcurrency }
      : {}),
  };
}

/** Resolves once the manager emits a terminal `pr-review-completed`/`-failed`. */
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
    if (event.type === 'pr-review-completed' || event.type === 'pr-review-failed') {
      resolve(events);
    }
  };
  return { events, emit, done };
}

/** Emit a `session-completed` carrying `result`, then resolve. */
function completing(
  result: string,
): (emit: (e: NightcoreEvent) => void) => Promise<void> {
  return async (emit) => {
    emit({
      type: 'session-completed',
      sessionId: -1,
      result,
      costUsd: 0,
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

/** One finding on a CHANGED file (survives diff-relative grounding). */
const ONE_FINDING = JSON.stringify([
  { severity: 'high', file: 'src/a.ts', line: 10, title: 'Bug', body: 'drops errors' },
]);

const isValidator = (cfg: SessionRunnerConfig): boolean =>
  cfg.appendSystemPrompt?.includes('VALIDATING') ?? false;

/** The merge-verdict synthesis pass is routed by its distinct "ADJUDICATING" persona
 *  marker (the lens/validator personas never contain it). */
const isVerdict = (cfg: SessionRunnerConfig): boolean =>
  cfg.appendSystemPrompt?.includes('ADJUDICATING') ?? false;

/** A clean verdict object the fake returns for the synthesis session. */
const VERDICT_JSON = JSON.stringify({
  verdict: 'merge_with_changes',
  reasoning: 'small non-blocking fixes then merge',
});

/** Lens → canned findings; validator → drop nothing (`[]`); verdict → a clean object. */
function cannedFactory(): PrReviewRunnerFactory {
  return (cfg: SessionRunnerConfig, emit) => ({
    async run() {
      if (isVerdict(cfg)) {
        await completing(VERDICT_JSON)(emit);
        return;
      }
      await completing(isValidator(cfg) ? '[]' : ONE_FINDING)(emit);
    },
    async interrupt() {},
  });
}

describe('PrReviewScanManager — event ordering', () => {
  test('emits started → lens-started → lens-completed → completed', async () => {
    const { emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: cannedFactory(),
    });

    manager.start(startCommand(['security']));
    const events = await done;
    const types = events.map((e) => e.type);

    expect(types[0]).toBe('pr-review-started');
    expect(types[types.length - 1]).toBe('pr-review-completed');
    const lensStarted = types.indexOf('pr-review-lens-started');
    const lensCompleted = types.indexOf('pr-review-lens-completed');
    expect(lensStarted).toBeGreaterThan(0);
    expect(lensCompleted).toBeGreaterThan(lensStarted);

    const completed = events.find((e) => e.type === 'pr-review-completed');
    if (completed?.type !== 'pr-review-completed') throw new Error('no completed');
    expect(completed.findings).toHaveLength(1);
    expect(completed.findings[0]?.file).toBe('src/a.ts');
    expect(completed.findings[0]?.lens).toBe('security');
    expect(completed.lensesRun).toBe(1);

    const started = events.find((e) => e.type === 'pr-review-started');
    expect(started?.type === 'pr-review-started' && started.lenses).toEqual([
      'security',
    ]);
  });
});

describe('PrReviewScanManager — per-lens fan-out', () => {
  test('runs every requested lens and emits one lens-completed per lens', async () => {
    const { events, emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: cannedFactory(),
    });

    manager.start(
      startCommand(['security', 'logic', 'tests'], { maxConcurrency: 2 }),
    );
    await done;

    const completedLenses = events
      .filter((e) => e.type === 'pr-review-lens-completed')
      .map((e) => (e.type === 'pr-review-lens-completed' ? e.lens : ''));
    expect(completedLenses.sort()).toEqual(['logic', 'security', 'tests']);
  });
});

describe('PrReviewScanManager — diff-relative grounding', () => {
  test('drops a lens finding on a file that is NOT in the PR changed set', async () => {
    const offDiff = JSON.stringify([
      { severity: 'high', file: 'src/not-in-pr.ts', title: 'Ghost', body: 'x' },
    ]);
    const factory: PrReviewRunnerFactory = (cfg, emit) => ({
      async run() {
        if (isVerdict(cfg)) {
          await completing(VERDICT_JSON)(emit);
          return;
        }
        await completing(isValidator(cfg) ? '[]' : offDiff)(emit);
      },
      async interrupt() {},
    });
    const { emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['security']));
    const events = await done;
    const completed = events.find((e) => e.type === 'pr-review-completed');
    expect(
      completed?.type === 'pr-review-completed' && completed.findings,
    ).toHaveLength(0);
    // …and the streamed per-lens batch was already filtered too.
    const lens = events.find((e) => e.type === 'pr-review-lens-completed');
    expect(
      lens?.type === 'pr-review-lens-completed' && lens.findings,
    ).toHaveLength(0);
  });
});

describe('PrReviewScanManager — untrusted diff framing + size cap', () => {
  /** Capture the composed LENS prompt (the pass that is neither validator nor verdict). */
  function capturingFactory(onLensPrompt: (p: string) => void): PrReviewRunnerFactory {
    return (cfg: SessionRunnerConfig, emit) => ({
      async run() {
        if (isVerdict(cfg)) {
          await completing(VERDICT_JSON)(emit);
          return;
        }
        if (isValidator(cfg)) {
          await completing('[]')(emit);
          return;
        }
        onLensPrompt(cfg.prompt);
        await completing(ONE_FINDING)(emit);
      },
      async interrupt() {},
    });
  }

  test('wraps the PR diff in the untrusted block, not our instructions', async () => {
    let lensPrompt = '';
    const { emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: capturingFactory((p) => {
        lensPrompt = p;
      }),
    });

    manager.start(startCommand(['security']));
    await done;

    const begin = lensPrompt.indexOf('<<<BEGIN UNTRUSTED PR DIFF>>>');
    const end = lensPrompt.indexOf('<<<END UNTRUSTED PR DIFF>>>');
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    // The FOREIGN diff sits INSIDE the fence…
    const inner = lensPrompt.slice(begin, end);
    expect(inner).toContain('oops();');
    // …and OUR instructions sit OUTSIDE it (the delimiters surround the diff only).
    expect(lensPrompt.slice(0, begin)).toContain('Review lens:');
    expect(inner).not.toContain('Review lens:');
  });

  test('truncates an oversized diff with a visible marker', async () => {
    let lensPrompt = '';
    const bigDiff = `diff --git a/src/a.ts b/src/a.ts\n@@\n+ ${'z'.repeat(MAX_DIFF_BYTES + 4096)}`;
    const { emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: capturingFactory((p) => {
        lensPrompt = p;
      }),
    });

    manager.start({ ...startCommand(['security']), diff: bigDiff });
    await done;

    expect(lensPrompt).toContain('[diff truncated at');
    // The marker is inside the untrusted fence (still framed as data).
    const end = lensPrompt.indexOf('<<<END UNTRUSTED PR DIFF>>>');
    expect(lensPrompt.indexOf('[diff truncated at')).toBeLessThan(end);
  });

  test('leaves a small diff untruncated', async () => {
    let lensPrompt = '';
    const { emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: capturingFactory((p) => {
        lensPrompt = p;
      }),
    });

    manager.start(startCommand(['security']));
    await done;

    expect(lensPrompt).not.toContain('[diff truncated');
  });
});

describe('PrReviewScanManager — corrective retry', () => {
  test('a non-JSON-then-JSON lens triggers exactly ONE corrective retry', async () => {
    let lensCalls = 0;
    const factory: PrReviewRunnerFactory = (cfg: SessionRunnerConfig, emit) => ({
      async run() {
        if (isVerdict(cfg)) {
          await completing(VERDICT_JSON)(emit);
          return;
        }
        if (isValidator(cfg)) {
          await completing('[]')(emit);
          return;
        }
        lensCalls++;
        const isRetry = cfg.prompt.includes('was not valid JSON');
        await completing(isRetry ? ONE_FINDING : 'prose, not json')(emit);
      },
      async interrupt() {},
    });

    const { emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['security']));
    const events = await done;
    expect(lensCalls).toBe(2); // one original + one retry
    const completed = events.find((e) => e.type === 'pr-review-completed');
    expect(
      completed?.type === 'pr-review-completed' && completed.findings,
    ).toHaveLength(1);
  });
});

describe('PrReviewScanManager — validator', () => {
  test('the validator drops a flagged finding before completion', async () => {
    const droppedId = `security-${reviewFingerprint('security', 'src/a.ts', 'Bug')}`;
    const factory: PrReviewRunnerFactory = (cfg, emit) => ({
      async run() {
        if (isVerdict(cfg)) {
          await completing(VERDICT_JSON)(emit);
          return;
        }
        await completing(
          isValidator(cfg) ? JSON.stringify([droppedId]) : ONE_FINDING,
        )(emit);
      },
      async interrupt() {},
    });
    const { emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['security']));
    const events = await done;
    const completed = events.find((e) => e.type === 'pr-review-completed');
    // The lens-completed batch still carried it; the validator removed it from the
    // terminal survivors.
    expect(
      completed?.type === 'pr-review-completed' && completed.findings,
    ).toHaveLength(0);
    const lens = events.find((e) => e.type === 'pr-review-lens-completed');
    expect(
      lens?.type === 'pr-review-lens-completed' && lens.findings,
    ).toHaveLength(1);
  });

  test('FAIL-OPEN: a validator that throws still completes with all findings', async () => {
    const factory: PrReviewRunnerFactory = (cfg, emit) => ({
      async run() {
        if (isVerdict(cfg)) {
          await completing(VERDICT_JSON)(emit);
          return;
        }
        if (isValidator(cfg)) throw new Error('validator exploded');
        await completing(ONE_FINDING)(emit);
      },
      async interrupt() {},
    });
    const { emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['security']));
    const events = await done;
    const completed = events.find((e) => e.type === 'pr-review-completed');
    expect(completed).toBeDefined();
    expect(
      completed?.type === 'pr-review-completed' && completed.findings,
    ).toHaveLength(1);
    // A crashed validator must never surface as a run failure.
    expect(events.some((e) => e.type === 'pr-review-failed')).toBe(false);
  });
});

describe('PrReviewScanManager — merge verdict', () => {
  test('folds the synthesis verdict + reasoning onto pr-review-completed', async () => {
    const factory: PrReviewRunnerFactory = (cfg, emit) => ({
      async run() {
        if (isVerdict(cfg)) {
          await completing(
            JSON.stringify({
              verdict: 'needs_revision',
              reasoning: 'fix the dropped-error bug before merge',
            }),
          )(emit);
          return;
        }
        await completing(isValidator(cfg) ? '[]' : ONE_FINDING)(emit);
      },
      async interrupt() {},
    });
    const { emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['security']));
    const events = await done;
    const completed = events.find((e) => e.type === 'pr-review-completed');
    if (completed?.type !== 'pr-review-completed') throw new Error('no completed');
    expect(completed.verdict).toBe('needs_revision');
    expect(completed.verdictReasoning).toBe(
      'fix the dropped-error bug before merge',
    );
  });

  test('CLAMPS an out-of-band model verdict + stamps verdictClamped/clampReason', async () => {
    // The model proposes a soft `ready`, but the surviving finding is `high` — the
    // clamp floors the emitted verdict at `needs_revision` and records why.
    const factory: PrReviewRunnerFactory = (cfg, emit) => ({
      async run() {
        if (isVerdict(cfg)) {
          await completing(
            JSON.stringify({ verdict: 'ready', reasoning: 'looks fine to me' }),
          )(emit);
          return;
        }
        // ONE_FINDING is a `high` finding on src/a.ts (kept by the empty drop-list).
        await completing(isValidator(cfg) ? '[]' : ONE_FINDING)(emit);
      },
      async interrupt() {},
    });
    const { emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['security']));
    const events = await done;
    const completed = events.find((e) => e.type === 'pr-review-completed');
    if (completed?.type !== 'pr-review-completed') throw new Error('no completed');
    // The emitted verdict is the CLAMPED value, not the model's raw `ready`.
    expect(completed.verdict).toBe('needs_revision');
    expect(completed.verdictClamped).toBe(true);
    expect(completed.clampReason).toContain('high');
    // The model's own reasoning still rides along untouched.
    expect(completed.verdictReasoning).toBe('looks fine to me');
  });

  test('does NOT stamp verdictClamped when the model verdict is already in-band', async () => {
    // The model proposes `needs_revision`, which IS in-band for a `high` finding —
    // it passes through and no clamp fields are emitted.
    const factory: PrReviewRunnerFactory = (cfg, emit) => ({
      async run() {
        if (isVerdict(cfg)) {
          await completing(
            JSON.stringify({ verdict: 'needs_revision', reasoning: 'fix first' }),
          )(emit);
          return;
        }
        await completing(isValidator(cfg) ? '[]' : ONE_FINDING)(emit);
      },
      async interrupt() {},
    });
    const { emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['security']));
    const events = await done;
    const completed = events.find((e) => e.type === 'pr-review-completed');
    if (completed?.type !== 'pr-review-completed') throw new Error('no completed');
    expect(completed.verdict).toBe('needs_revision');
    expect(completed.verdictClamped).toBeUndefined();
    expect(completed.clampReason).toBeUndefined();
  });

  test('FAIL-OPEN: a synthesis pass that throws completes WITHOUT verdict fields', async () => {
    const factory: PrReviewRunnerFactory = (cfg, emit) => ({
      async run() {
        if (isVerdict(cfg)) throw new Error('verdict exploded');
        await completing(isValidator(cfg) ? '[]' : ONE_FINDING)(emit);
      },
      async interrupt() {},
    });
    const { emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['security']));
    const events = await done;
    const completed = events.find((e) => e.type === 'pr-review-completed');
    if (completed?.type !== 'pr-review-completed') throw new Error('no completed');
    // A crashed synthesis must never lose the run: it completes with its findings,
    // just without the (optional) verdict fields, and never surfaces a failure.
    expect(completed.verdict).toBeUndefined();
    expect(completed.verdictReasoning).toBeUndefined();
    expect(completed.findings).toHaveLength(1);
    expect(events.some((e) => e.type === 'pr-review-failed')).toBe(false);
  });
});

describe('PrReviewScanManager — cancellation', () => {
  test('cancel interrupts live lens passes and surfaces reason "aborted"', async () => {
    const live: Array<() => void> = [];
    const factory: PrReviewRunnerFactory = (_cfg, emit) => {
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
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['security', 'logic']));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(live.length).toBeGreaterThan(0);
    manager.cancel('run-1');

    const events = await done;
    const failed = events.find((e) => e.type === 'pr-review-failed');
    expect(failed).toBeDefined();
    expect(failed?.type === 'pr-review-failed' && failed.reason).toBe('aborted');
  });
});

describe('PrReviewScanManager — duplicate start', () => {
  test('a duplicate-runId start() is ignored', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const factory: PrReviewRunnerFactory = (cfg: SessionRunnerConfig, emit) => ({
      async run() {
        if (isVerdict(cfg)) {
          await completing(VERDICT_JSON)(emit);
          return;
        }
        if (!isValidator(cfg)) await gate;
        await completing(isValidator(cfg) ? '[]' : ONE_FINDING)(emit);
      },
      async interrupt() {},
    });

    const { events, emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['security'], { runId: 'dup' }));
    manager.start(startCommand(['logic'], { runId: 'dup' }));
    release();
    await done;

    const starts = events.filter((e) => e.type === 'pr-review-started');
    expect(starts).toHaveLength(1);
    const lensStarts = events.filter((e) => e.type === 'pr-review-lens-started');
    expect(lensStarts).toHaveLength(1);
  });
});

// ─── Deep mode (issue #294): the multi-round convergence loop ────────────────────

/** A deep `start-pr-review` command (opts into the round loop). */
function deepCommand(
  lenses: ReviewLens[],
  deep: Partial<DeepScanConfig> = {},
): StartPrReview {
  return {
    ...startCommand(lenses),
    deep: {
      maxRoundsPerCategory: 15,
      convergenceEmptyRounds: 2,
      maxFindingsPerRound: 20,
      ...deep,
    },
  };
}

/** A finding on the CHANGED file with the given title — survives diff-relative
 *  grounding and is fingerprinted by `lens | file | title`, so repeating a title on
 *  the same file reads as zero net-new. */
function reviewJson(title: string): string {
  return JSON.stringify([
    { severity: 'high', file: 'src/a.ts', line: 10, title, body: 'b' },
  ]);
}

describe('PrReviewScanManager — deep mode: convergence (diff-bounded self-limit)', () => {
  test('stops after K consecutive zero-net-new rounds', async () => {
    let rounds = 0;
    const factory: PrReviewRunnerFactory = (cfg: SessionRunnerConfig, emit) => ({
      async run() {
        if (isValidator(cfg)) return void (await completing('[]')(emit));
        if (isVerdict(cfg)) return void (await completing(VERDICT_JSON)(emit));
        rounds++;
        // Always the SAME finding: round 1 is 1 net-new, every later round is 0.
        await completing(reviewJson('SQL injection'))(emit);
      },
      async interrupt() {},
    });

    const { events, emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(
      deepCommand(['security'], { convergenceEmptyRounds: 2, maxRoundsPerCategory: 15 }),
    );
    await done;

    // r1: 1 new (streak 0) · r2: 0 new (streak 1) · r3: 0 new (streak 2 = K) → stop.
    expect(rounds).toBe(3);
    const roundEvents = events.filter(
      (e) => e.type === 'pr-review-round-completed',
    );
    expect(roundEvents).toHaveLength(3);
    expect(
      roundEvents.map((e) =>
        e.type === 'pr-review-round-completed' ? e.newFindingsThisRound : -1,
      ),
    ).toEqual([1, 0, 0]);
    // The round event's cumulative set is diff-grounded (the changed file is kept).
    const lastRound = roundEvents[roundEvents.length - 1];
    expect(
      lastRound?.type === 'pr-review-round-completed' && lastRound.findings.length,
    ).toBe(1);
    // Deep mode NEVER emits the classic per-lens terminal (no double-count).
    expect(
      events.filter((e) => e.type === 'pr-review-lens-completed'),
    ).toHaveLength(0);
    // The run still finishes through validator + verdict.
    expect(events.some((e) => e.type === 'pr-review-completed')).toBe(true);
  });
});

describe('PrReviewScanManager — deep mode: exclusion prompt', () => {
  test('round 1 has no exclusion list; round ≥ 2 excludes prior findings and asks for NEW', async () => {
    const prompts: string[] = [];
    let rounds = 0;
    const factory: PrReviewRunnerFactory = (cfg: SessionRunnerConfig, emit) => ({
      async run() {
        if (isValidator(cfg)) return void (await completing('[]')(emit));
        if (isVerdict(cfg)) return void (await completing(VERDICT_JSON)(emit));
        rounds++;
        prompts.push(cfg.prompt);
        // A UNIQUE finding each round → 1 net-new each → the backstop stops it.
        await completing(reviewJson(`Issue ${rounds}`))(emit);
      },
      async interrupt() {},
    });

    const { emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(
      deepCommand(['security'], {
        convergenceEmptyRounds: 2,
        maxRoundsPerCategory: 3,
        maxFindingsPerRound: 20,
      }),
    );
    await done;

    expect(prompts.length).toBeGreaterThanOrEqual(2);
    // Round 1: no exclusion list, classic cap wording at the deep per-round cap (20).
    expect(prompts[0]).not.toContain('ALREADY FOUND');
    expect(prompts[0]).toContain('Return AT MOST 20 findings for this lens');
    // Round 2: the exclusion list (with round-1's title) + the NEW-findings contract.
    expect(prompts[1]).toContain('ALREADY FOUND');
    expect(prompts[1]).toContain('Issue 1');
    expect(prompts[1]).toContain('Return AT MOST 20 **NEW** findings for this lens');
  });
});

describe('PrReviewScanManager — deep OFF path is unchanged', () => {
  test('a non-deep command runs one lens session and emits the classic per-lens event (no round events)', async () => {
    let lensCalls = 0;
    const factory: PrReviewRunnerFactory = (cfg: SessionRunnerConfig, emit) => ({
      async run() {
        if (isValidator(cfg)) return void (await completing('[]')(emit));
        if (isVerdict(cfg)) return void (await completing(VERDICT_JSON)(emit));
        lensCalls++;
        await completing(ONE_FINDING)(emit);
      },
      async interrupt() {},
    });

    const { events, emit, done } = collect();
    const manager = new PrReviewScanManager({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit,
      runnerFactory: factory,
    });

    manager.start(startCommand(['security']));
    await done;

    // Exactly one lens session (valid JSON ⇒ no corrective retry) — byte-identical to pre-deep.
    expect(lensCalls).toBe(1);
    expect(
      events.filter((e) => e.type === 'pr-review-lens-completed'),
    ).toHaveLength(1);
    expect(
      events.filter((e) => e.type === 'pr-review-round-completed'),
    ).toHaveLength(0);
  });
});
