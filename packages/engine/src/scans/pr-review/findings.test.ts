/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { ReviewFinding, ReviewLens, ReviewSeverity } from '@nightcore/contracts';

import {
  dedupePrReviewFindings,
  groundPrReviewFindings,
  parsePrReviewFindings,
  reviewFingerprint,
  reviewSeverityRank,
} from './findings.js';

describe('parsePrReviewFindings', () => {
  test('coerces a valid array, forces lens, assigns id + fingerprint', () => {
    const raw = JSON.stringify([
      {
        severity: 'high',
        file: './src/a.ts',
        line: 12,
        title: 'Unvalidated input',
        body: 'the handler trusts the body',
        suggestedFix: 'validate with zod',
      },
    ]);
    const { findings, error } = parsePrReviewFindings(raw, 'security');
    expect(error).toBeUndefined();
    expect(findings).toHaveLength(1);
    const f = findings[0] as ReviewFinding;
    expect(f.lens).toBe('security');
    expect(f.severity).toBe('high');
    expect(f.file).toBe('src/a.ts'); // normalized (leading ./ stripped)
    expect(f.line).toBe(12);
    expect(f.suggestedFix).toBe('validate with zod');
    expect(f.id.startsWith('security-')).toBe(true);
    expect(f.fingerprint.length).toBeGreaterThan(0);
  });

  test('accepts an object with a findings array', () => {
    const raw = JSON.stringify({
      findings: [{ file: 'src/x.ts', title: 't', body: 'd' }],
    });
    const { findings } = parsePrReviewFindings(raw, 'logic');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.lens).toBe('logic');
  });

  test('accepts an empty {findings:[]} wrapper as zero findings, no error', () => {
    const { findings, error } = parsePrReviewFindings(
      JSON.stringify({ findings: [] }),
      'tests',
    );
    expect(error).toBeUndefined();
    expect(findings).toHaveLength(0);
  });

  test('accepts "body" via the "description" fallback and a "file:line" string', () => {
    const raw = JSON.stringify([
      { file: 'src/y.ts:9', title: 't', description: 'via description key' },
    ]);
    const { findings } = parsePrReviewFindings(raw, 'structure');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe('src/y.ts');
    expect(findings[0]?.line).toBe(9);
    expect(findings[0]?.body).toBe('via description key');
  });

  test('maps synonym severities onto the unified scale', () => {
    const raw = JSON.stringify([
      { severity: 'warning', file: 'src/a.ts', title: 'a', body: 'd' },
      { severity: 'major', file: 'src/a.ts', title: 'b', body: 'd' },
    ]);
    const { findings } = parsePrReviewFindings(raw, 'logic');
    expect(findings[0]?.severity).toBe('low');
    expect(findings[1]?.severity).toBe('high');
  });

  test('drops items missing title/body or a locatable file, keeps valid ones', () => {
    const raw = JSON.stringify([
      { severity: 'low', file: 'src/a.ts', title: 'no body' },
      { title: 'no file', body: 'present' },
      { file: 'src/a.ts', title: 'ok', body: 'present' },
    ]);
    const { findings } = parsePrReviewFindings(raw, 'contracts');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe('ok');
  });

  test('drops a non-positive / non-integer line rather than failing the finding', () => {
    const raw = JSON.stringify([
      { file: 'src/a.ts', title: 't', body: 'd', line: 0 },
      { file: 'src/b.ts', title: 't2', body: 'd', line: 3.5 },
    ]);
    const { findings } = parsePrReviewFindings(raw, 'logic');
    expect(findings).toHaveLength(2);
    expect(findings[0]?.line).toBeUndefined();
    expect(findings[1]?.line).toBeUndefined();
  });

  test('reports an error when no JSON is present (drives the corrective retry)', () => {
    const { findings, error } = parsePrReviewFindings('the diff looks fine', 'tests');
    expect(findings).toHaveLength(0);
    expect(error).toBeDefined();
  });
});

describe('reviewFingerprint', () => {
  test('is stable across whitespace/case differences in the title', () => {
    const a = reviewFingerprint('security', 'src/a.ts', 'Unvalidated  Input');
    const b = reviewFingerprint('security', 'src/a.ts', 'unvalidated input');
    expect(a).toBe(b);
  });

  test('differs by lens and by file', () => {
    expect(reviewFingerprint('security', 'src/a.ts', 'x')).not.toBe(
      reviewFingerprint('logic', 'src/a.ts', 'x'),
    );
    expect(reviewFingerprint('security', 'src/a.ts', 'x')).not.toBe(
      reviewFingerprint('security', 'src/b.ts', 'x'),
    );
  });
});

describe('groundPrReviewFindings (diff-relative)', () => {
  function finding(over: Partial<ReviewFinding>): ReviewFinding {
    return {
      id: 'id',
      lens: 'security',
      severity: 'medium',
      file: 'src/a.ts',
      title: 't',
      body: 'd',
      fingerprint: 'fp',
      ...over,
    };
  }

  test('keeps a finding whose file is in the PR changed-file set', () => {
    const out = groundPrReviewFindings([finding({ file: 'src/a.ts' })], [
      'src/a.ts',
      'src/b.ts',
    ]);
    expect(out).toHaveLength(1);
  });

  test('drops a finding whose file is NOT a changed file (even if it exists on disk)', () => {
    // Diff-relative: not disk existence. `package.json` surely exists, but it is not
    // in this PR's changed set → dropped.
    const out = groundPrReviewFindings([finding({ file: 'package.json' })], [
      'src/a.ts',
    ]);
    expect(out).toHaveLength(0);
  });

  test('keeps a NEW file that is not on disk but IS in the changed set', () => {
    // A PR that adds `new.rs` has no `new.rs` in the current checkout; disk-grounding
    // would wrongly drop it. Diff-relative grounding keeps it.
    const out = groundPrReviewFindings([finding({ file: 'crates/new.rs' })], [
      'crates/new.rs',
    ]);
    expect(out).toHaveLength(1);
  });

  test('normalizes both sides so ./a and a compare equal', () => {
    const out = groundPrReviewFindings([finding({ file: './src/a.ts' })], [
      'src/a.ts',
    ]);
    expect(out).toHaveLength(1);
  });

  test('handles an empty/missing file field by dropping it (never in the set)', () => {
    const out = groundPrReviewFindings([finding({ file: '' })], ['src/a.ts']);
    expect(out).toHaveLength(0);
  });
});

describe('dedupePrReviewFindings', () => {
  function finding(over: Partial<ReviewFinding>): ReviewFinding {
    return {
      id: 'id',
      lens: 'security',
      severity: 'medium',
      file: 'src/a.ts',
      title: 't',
      body: 'd',
      fingerprint: 'fp',
      ...over,
    };
  }

  test('merges the same fingerprint, keeping the higher-severity instance', () => {
    const out = dedupePrReviewFindings([
      finding({ severity: 'low', fingerprint: 'shared', title: 'Injection', id: 'a' }),
      finding({ severity: 'critical', fingerprint: 'shared', title: 'Injection', id: 'b' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe('critical');
  });

  test('does not merge distinct fingerprints and is order-stable', () => {
    const out = dedupePrReviewFindings([
      finding({ title: 'a', fingerprint: 'fp-a' }),
      finding({ title: 'b', fingerprint: 'fp-b' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.fingerprint)).toEqual(['fp-a', 'fp-b']);
  });
});

describe('reviewSeverityRank', () => {
  test('orders info → critical', () => {
    const order: ReviewSeverity[] = ['info', 'low', 'medium', 'high', 'critical'];
    for (let i = 1; i < order.length; i++) {
      expect(reviewSeverityRank(order[i - 1] as ReviewSeverity)).toBeLessThan(
        reviewSeverityRank(order[i] as ReviewSeverity),
      );
    }
  });

  test('every lens resolves to a real fingerprint (sanity over the 5 lenses)', () => {
    const lenses: ReviewLens[] = [
      'security',
      'logic',
      'structure',
      'tests',
      'contracts',
    ];
    for (const lens of lenses) {
      expect(reviewFingerprint(lens, 'src/a.ts', 't').length).toBe(16);
    }
  });
});
