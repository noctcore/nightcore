/** The deep conformance audit's grounding rules (#279). These are what stop an
 *  LLM-judged verdict from entering the drift plane as if it were a measurement. */
import { describe, expect, test } from 'bun:test';

import type { ConformanceAuditTarget } from '@nightcore/contracts';

import {
  buildAuditPrompt,
  groundAuditVerdicts,
  MAX_AUDITED_CONVENTIONS,
  parseAuditVerdicts,
} from './audit.js';

const MODEL = 'claude-opus-4-8';

function target(fingerprint: string): ConformanceAuditTarget {
  return {
    fingerprint,
    category: 'folder-structure',
    title: `convention ${fingerprint}`,
    description: 'does a thing',
  };
}

/** A verdict as the model would return it. */
function verdict(over: Record<string, unknown>): string {
  return JSON.stringify([
    { fingerprint: 'a', status: 'clean', sitesChecked: 10, sitesMatched: 0, ...over },
  ]);
}

describe('parseAuditVerdicts', () => {
  test('accepts a bare array and a fenced one', () => {
    expect(parseAuditVerdicts(verdict({}))?.length).toBe(1);
    expect(parseAuditVerdicts('```json\n' + verdict({}) + '\n```')?.length).toBe(1);
  });

  test('returns undefined for prose (which drives the corrective retry)', () => {
    expect(parseAuditVerdicts('I looked and everything seems fine.')).toBeUndefined();
  });

  test('drops an entry with no fingerprint (nothing to join to)', () => {
    const parsed = parseAuditVerdicts(
      JSON.stringify([{ status: 'clean', sitesChecked: 3, sitesMatched: 0 }]),
    );
    expect(parsed).toEqual([]);
  });
});

describe('groundAuditVerdicts', () => {
  test('a real clean keeps its examined-site count and names the judge', () => {
    const [record] = groundAuditVerdicts(
      [target('a')],
      parseAuditVerdicts(verdict({})) ?? [],
      MODEL,
    );
    expect(record?.status).toBe('clean');
    expect(record?.sitesChecked).toBe(10);
    expect(record?.sitesMatched).toBe(0);
    expect(record?.method).toBe(`deep-audit: ${MODEL}`);
    expect(record?.conventionFingerprint).toBe('a');
    expect(record?.id).toBe('drift-a');
  });

  test('a clean with ZERO examined sites is downgraded to errored', () => {
    // The whole point of the fail-visible rule: a model that read nothing has
    // established nothing, so it may not report a pass.
    const raw = parseAuditVerdicts(verdict({ sitesChecked: 0 })) ?? [];
    const [record] = groundAuditVerdicts([target('a')], raw, MODEL);
    expect(record?.status).toBe('errored');
    expect(record?.sitesChecked).toBe(0);
    expect(record?.errorReason).toContain('without examining any site');
  });

  test('a drifted verdict with no violating site is errored, not clean', () => {
    const raw = parseAuditVerdicts(verdict({ status: 'drifted', sitesMatched: 0 })) ?? [];
    const [record] = groundAuditVerdicts([target('a')], raw, MODEL);
    expect(record?.status).toBe('errored');
    expect(record?.errorReason).toContain('no violating site');
  });

  test('violations are clamped to the sites actually examined', () => {
    const raw =
      parseAuditVerdicts(verdict({ status: 'drifted', sitesChecked: 4, sitesMatched: 99 })) ??
      [];
    const [record] = groundAuditVerdicts([target('a')], raw, MODEL);
    expect(record?.status).toBe('drifted');
    expect(record?.sitesMatched).toBe(4);
    expect(record?.sitesChecked).toBe(4);
  });

  test('a convention the model never answered comes back errored, never clean', () => {
    const records = groundAuditVerdicts(
      [target('a'), target('b')],
      parseAuditVerdicts(verdict({})) ?? [],
      MODEL,
    );
    expect(records).toHaveLength(2);
    expect(records[1]?.status).toBe('errored');
    expect(records[1]?.errorReason).toContain('no verdict');
  });

  test('a fingerprint that was never requested cannot enter the drift plane', () => {
    const raw =
      parseAuditVerdicts(
        JSON.stringify([
          { fingerprint: 'a', status: 'clean', sitesChecked: 5, sitesMatched: 0 },
          { fingerprint: 'hallucinated', status: 'drifted', sitesChecked: 9, sitesMatched: 9 },
        ]),
      ) ?? [];
    const records = groundAuditVerdicts([target('a')], raw, MODEL);
    expect(records.map((r) => r.conventionFingerprint)).toEqual(['a']);
  });

  test('an unknown status is errored rather than silently trusted', () => {
    const raw = parseAuditVerdicts(verdict({ status: 'probably-fine' })) ?? [];
    const [record] = groundAuditVerdicts([target('a')], raw, MODEL);
    expect(record?.status).toBe('errored');
    expect(record?.errorReason).toContain('unknown status');
  });

  test("the model's own `errored` keeps its note as the reason", () => {
    const raw =
      parseAuditVerdicts(verdict({ status: 'errored', note: 'could not find the sites' })) ??
      [];
    const [record] = groundAuditVerdicts([target('a')], raw, MODEL);
    expect(record?.status).toBe('errored');
    expect(record?.errorReason).toBe('could not find the sites');
  });
});

describe('buildAuditPrompt', () => {
  test('carries each fingerprint and forbids an unexamined clean', () => {
    const prompt = buildAuditPrompt('/repo', [target('a'), target('b')]);
    expect(prompt).toContain('(a)');
    expect(prompt).toContain('(b)');
    expect(prompt).toContain('NEVER report `clean` unless you actually examined sites');
    expect(prompt).toContain('invent no others');
  });

  test('the per-pass convention cap is a real bound', () => {
    expect(MAX_AUDITED_CONVENTIONS).toBeGreaterThan(0);
    expect(MAX_AUDITED_CONVENTIONS).toBeLessThanOrEqual(25);
  });
});
