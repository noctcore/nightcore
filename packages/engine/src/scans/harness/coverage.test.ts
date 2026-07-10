/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  type Config,
  ConfigSchema,
  type ConventionFinding,
  type NightcoreEvent,
  type SurfaceCommand,
} from '@nightcore/contracts';

import type { SessionRunnerConfig } from '../../session/session-runner.js';
import type { ScanRunnerFactory } from '../shared/scan-manager.js';
import { computeCoverage, parseCoverage, preMatchRule } from './coverage.js';
import type { RuleInventory } from './inventory.js';

type StartHarnessScan = Extract<SurfaceCommand, { type: 'start-harness-scan' }>;

const BASE_CONFIG: Config = ConfigSchema.parse({
  paths: { home: '/tmp/nc-home', sessions: '/tmp/nc-home/sessions' },
});

const COMMAND: StartHarnessScan = {
  type: 'start-harness-scan',
  runId: 'run-cov',
  projectPath: '/proj',
  categories: ['imports-boundaries'],
};

function finding(over: Partial<ConventionFinding> = {}): ConventionFinding {
  return {
    id: 'cf',
    category: 'imports-boundaries',
    kind: 'convention',
    severity: 'medium',
    title: 'A convention',
    description: 'd',
    evidence: [],
    tags: [],
    fingerprint: 'fp',
    ...over,
  };
}

/** A fake runner that answers every session with `result`. */
function cannedFactory(result: string): ScanRunnerFactory {
  return (_cfg: SessionRunnerConfig, emit) => ({
    async run() {
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
    },
    async interrupt() {},
  });
}

/** A fake runner that FAILS the session — exercises the fail-open path. */
function failingFactory(): ScanRunnerFactory {
  return (_cfg: SessionRunnerConfig, emit) => ({
    async run() {
      emit({
        type: 'session-failed',
        sessionId: -1,
        reason: 'unknown',
        message: 'boom',
      } as NightcoreEvent);
    },
    async interrupt() {},
  });
}

function neverRunsFactory(): ScanRunnerFactory {
  return () => ({
    async run() {
      throw new Error('the coverage session must NOT run for this case');
    },
    async interrupt() {},
  });
}

describe('preMatchRule', () => {
  test('matches a convention to an enforcing rule by strong token overlap', () => {
    const f = finding({
      title: 'Components follow strict folder-per-component',
      tags: ['folder-per-component'],
    });
    expect(preMatchRule(f, ['nightcore/component-folder-structure'])).toBe(
      'nightcore/component-folder-structure',
    );
  });

  test('does not match an unrelated rule', () => {
    const f = finding({ title: 'Prefer composition over inheritance', tags: ['composition'] });
    expect(preMatchRule(f, ['nightcore/no-cross-feature-imports'])).toBeUndefined();
  });
});

describe('parseCoverage', () => {
  test('drops a hallucinated enforcedBy id and downgrades enforced-without-rule', () => {
    const residue = [finding({ fingerprint: 'fp-1', title: 'x' })];
    const raw = JSON.stringify({
      coverage: [
        {
          conventionFingerprint: 'fp-1',
          status: 'enforced',
          enforcedBy: ['nightcore/does-not-exist'],
        },
      ],
    });
    const { records } = parseCoverage(raw, residue, {
      ruleIds: ['nightcore/real-rule'],
      docClaims: [],
      count: 1,
    });
    const rec = records.get('fp-1');
    expect(rec?.status).toBe('unenforced'); // hallucinated id dropped → downgraded
    expect(rec?.enforcedBy).toEqual([]);
  });

  test('accepts documented-only and reports no-JSON as an error', () => {
    const residue = [finding({ fingerprint: 'fp-2' })];
    const inv: RuleInventory = { ruleIds: [], docClaims: ['claim'], count: 0 };
    const ok = parseCoverage(
      JSON.stringify({
        coverage: [
          { conventionFingerprint: 'fp-2', status: 'documented-only', documentedIn: ['claim'] },
        ],
      }),
      residue,
      inv,
    );
    expect(ok.records.get('fp-2')?.status).toBe('documented-only');

    const bad = parseCoverage('sorry, prose not json', residue, inv);
    expect(bad.error).toBeDefined();
  });
});

describe('computeCoverage', () => {
  const args = (over: Partial<Parameters<typeof computeCoverage>[0]>) => ({
    command: COMMAND,
    config: BASE_CONFIG,
    apiKeyFallback: false,
    runnerFactory: neverRunsFactory(),
    ...over,
  });

  test('no findings → empty coverage, no session', async () => {
    const res = await computeCoverage(
      args({ findings: [], inventory: { ruleIds: [], docClaims: [], count: 0 } }),
    );
    expect(res.coverage).toEqual([]);
    expect(res.costUsd).toBe(0);
  });

  test('empty inventory short-circuits every convention to unenforced (no LLM)', async () => {
    const res = await computeCoverage(
      args({
        findings: [finding({ fingerprint: 'a' }), finding({ fingerprint: 'b' })],
        inventory: { ruleIds: [], docClaims: [], count: 0 },
        runnerFactory: neverRunsFactory(),
      }),
    );
    expect(res.coverage).toHaveLength(2);
    expect(res.coverage.every((c) => c.status === 'unenforced')).toBe(true);
    expect(res.costUsd).toBe(0);
  });

  test('pre-matches the obvious pair and joins the residue via one no-tool session', async () => {
    const enforced = finding({
      fingerprint: 'fp-enforced',
      title: 'Components follow strict folder-per-component',
      tags: ['folder-per-component'],
    });
    const residue = finding({
      fingerprint: 'fp-residue',
      title: 'Errors go through the taxonomy',
      tags: ['error-handling'],
    });
    const inventory: RuleInventory = {
      ruleIds: ['nightcore/component-folder-structure'],
      docClaims: ['Errors go through the taxonomy.'],
      count: 1,
    };
    const joinAnswer = JSON.stringify({
      coverage: [
        {
          conventionFingerprint: 'fp-residue',
          status: 'documented-only',
          documentedIn: ['Errors go through the taxonomy.'],
        },
      ],
    });
    const res = await computeCoverage(
      args({
        findings: [enforced, residue],
        inventory,
        runnerFactory: cannedFactory(joinAnswer),
      }),
    );
    const byFp = new Map(res.coverage.map((c) => [c.conventionFingerprint, c]));
    expect(byFp.get('fp-enforced')?.status).toBe('enforced'); // deterministic pre-match
    expect(byFp.get('fp-enforced')?.enforcedBy).toEqual([
      'nightcore/component-folder-structure',
    ]);
    expect(byFp.get('fp-residue')?.status).toBe('documented-only'); // from the join
  });

  test('a failed join fails open — the residue degrades to unenforced', async () => {
    const residue = finding({ fingerprint: 'fp-x', title: 'Some fuzzy convention' });
    const res = await computeCoverage(
      args({
        findings: [residue],
        inventory: { ruleIds: ['nightcore/some-rule'], docClaims: [], count: 1 },
        runnerFactory: failingFactory(),
      }),
    );
    expect(res.coverage).toHaveLength(1);
    expect(res.coverage[0]?.status).toBe('unenforced');
    expect(res.error).toBeDefined();
  });
});
