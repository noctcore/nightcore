/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  type Config,
  ConfigSchema,
  type NightcoreEvent,
  type ReviewFinding,
  type SurfaceCommand,
} from '@nightcore/contracts';

import type { SessionRunnerConfig } from '../../session/session-runner.js';
import type { PrReviewRunnerFactory } from './manager.js';
import { validatePrReviewFindings } from './validator.js';

type StartPrReview = Extract<SurfaceCommand, { type: 'start-pr-review' }>;

const BASE_CONFIG: Config = ConfigSchema.parse({
  paths: { home: '/tmp/nc-home', sessions: '/tmp/nc-home/sessions' },
});

const COMMAND: StartPrReview = {
  type: 'start-pr-review',
  runId: 'run-1',
  projectPath: '/proj',
  prNumber: 7,
  diff: 'diff --git a/src/a.ts b/src/a.ts\n+ unsafe();',
  changedFiles: ['src/a.ts'],
  lenses: ['security'],
};

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'security-fp1',
    lens: 'security',
    severity: 'high',
    file: 'src/a.ts',
    title: 'Injection',
    body: 'unsafe call',
    fingerprint: 'fp1',
    ...over,
  };
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

function deps(runnerFactory: PrReviewRunnerFactory) {
  return {
    diff: COMMAND.diff,
    changedFiles: COMMAND.changedFiles,
    command: COMMAND,
    config: BASE_CONFIG,
    apiKeyFallback: false,
    runnerFactory,
  };
}

describe('validatePrReviewFindings — happy path', () => {
  test('drops only the ids the validator flags, keeps the rest', async () => {
    const keep = finding({ id: 'security-keep', fingerprint: 'keep' });
    const drop = finding({ id: 'security-drop', fingerprint: 'drop', title: 'FP' });
    const factory: PrReviewRunnerFactory = (_cfg, emit) => ({
      async run() {
        await completing(JSON.stringify(['security-drop']))(emit);
      },
      async interrupt() {},
    });

    const result = await validatePrReviewFindings({
      ...deps(factory),
      findings: [keep, drop],
    });
    expect(result.droppedIds).toEqual(['security-drop']);
    expect(result.findings.map((f) => f.id)).toEqual(['security-keep']);
    expect(result.error).toBeUndefined();
  });

  test('an id the validator invents (not in the candidate set) drops nothing', async () => {
    const factory: PrReviewRunnerFactory = (_cfg, emit) => ({
      async run() {
        await completing(JSON.stringify(['ghost-id']))(emit);
      },
      async interrupt() {},
    });
    const result = await validatePrReviewFindings({
      ...deps(factory),
      findings: [finding()],
    });
    expect(result.droppedIds).toEqual([]);
    expect(result.findings).toHaveLength(1);
  });

  test('accepts an object envelope { falsePositives: [...] }', async () => {
    const factory: PrReviewRunnerFactory = (_cfg, emit) => ({
      async run() {
        await completing(JSON.stringify({ falsePositives: ['security-fp1'] }))(emit);
      },
      async interrupt() {},
    });
    const result = await validatePrReviewFindings({
      ...deps(factory),
      findings: [finding()],
    });
    expect(result.findings).toHaveLength(0);
  });
});

describe('validatePrReviewFindings — no session when empty', () => {
  test('returns immediately without spinning a runner for zero findings', async () => {
    let spun = false;
    const factory: PrReviewRunnerFactory = () => {
      spun = true;
      return { async run() {}, async interrupt() {} };
    };
    const result = await validatePrReviewFindings({ ...deps(factory), findings: [] });
    expect(spun).toBe(false);
    expect(result.findings).toHaveLength(0);
  });
});

describe('validatePrReviewFindings — fail-open', () => {
  test('a runner that THROWS keeps ALL findings (never lose a real finding)', async () => {
    const factory: PrReviewRunnerFactory = () => ({
      async run() {
        throw new Error('validator exploded');
      },
      async interrupt() {},
    });
    const result = await validatePrReviewFindings({
      ...deps(factory),
      findings: [finding({ id: 'a' }), finding({ id: 'b', fingerprint: 'fp2' })],
    });
    expect(result.findings.map((f) => f.id)).toEqual(['a', 'b']);
    expect(result.droppedIds).toEqual([]);
    expect(result.error).toContain('exploded');
  });

  test('a non-JSON answer (after the one retry) keeps ALL findings', async () => {
    const factory: PrReviewRunnerFactory = (_cfg, emit) => ({
      async run() {
        await completing('sorry, I could not decide')(emit);
      },
      async interrupt() {},
    });
    const result = await validatePrReviewFindings({
      ...deps(factory),
      findings: [finding()],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.error).toBeDefined();
  });

  test('a session failure (no result) keeps ALL findings', async () => {
    const factory: PrReviewRunnerFactory = (_cfg, emit) => ({
      async run() {
        emit({
          type: 'session-failed',
          sessionId: -1,
          reason: 'runner-crash',
          message: 'boom',
        });
      },
      async interrupt() {},
    });
    const result = await validatePrReviewFindings({
      ...deps(factory),
      findings: [finding()],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.error).toBeDefined();
  });

  test('retries exactly ONCE on unparseable-then-valid', async () => {
    let calls = 0;
    const factory: PrReviewRunnerFactory = (cfg: SessionRunnerConfig, emit) => ({
      async run() {
        calls++;
        const isRetry = cfg.prompt.includes('was not valid JSON');
        await completing(isRetry ? '[]' : 'not json')(emit);
      },
      async interrupt() {},
    });
    const result = await validatePrReviewFindings({
      ...deps(factory),
      findings: [finding()],
    });
    expect(calls).toBe(2);
    expect(result.findings).toHaveLength(1);
    expect(result.error).toBeUndefined();
  });
});
