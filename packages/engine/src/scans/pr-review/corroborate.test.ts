/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { ReviewFinding, ReviewLens, ReviewSeverity } from '@nightcore/contracts';

import {
  corroboratePrReviewFindings,
  CORROBORATION_TUNING,
  corroborationCount,
  rankPrReviewFindings,
  titlesCorroborate,
  titleTokens,
  tokenSetSimilarity,
} from './corroborate.js';

/** A finding with just the fields corroboration + ranking read. */
function finding(
  lens: ReviewLens,
  file: string,
  title: string,
  severity: ReviewSeverity = 'medium',
  extra: Partial<ReviewFinding> = {},
): ReviewFinding {
  return {
    id: `${lens}-${title}`,
    lens,
    severity,
    file,
    title,
    body: 'b',
    fingerprint: `fp-${lens}-${title}`,
    ...extra,
  };
}

describe('titleTokens', () => {
  test('drops stopwords, short fragments, and splits on punctuation', () => {
    expect([...titleTokens('The missing null-check in the parser')].sort()).toEqual([
      'check',
      'missing',
      'null',
      'parser',
    ]);
  });

  test('splits snake_case and camel boundaries it can see (non-alphanumeric runs)', () => {
    expect([...titleTokens('unchecked user_input reaches exec()')].sort()).toEqual([
      'exec',
      'input',
      'reaches',
      'unchecked',
      'user',
    ]);
  });
});

describe('tokenSetSimilarity', () => {
  test('scores identical sets 1 and disjoint sets 0', () => {
    expect(tokenSetSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(tokenSetSimilarity(new Set(['a']), new Set(['b']))).toBe(0);
  });

  test('an empty set never agrees with anything (0, not 1)', () => {
    expect(tokenSetSimilarity(new Set(), new Set())).toBe(0);
    expect(tokenSetSimilarity(new Set(), new Set(['a']))).toBe(0);
  });
});

describe('titlesCorroborate', () => {
  test('matches re-phrased headlines of the same issue', () => {
    expect(
      titlesCorroborate(
        'Missing null check on the parsed config',
        'Parsed config is missing a null check',
      ),
    ).toBe(true);
  });

  test('rejects unrelated headlines that share a word', () => {
    expect(
      titlesCorroborate(
        'Missing null check on the parsed config',
        'Config file is committed with production secrets',
      ),
    ).toBe(false);
  });

  test('short titles need an identical token set (the ratio is too coarse there)', () => {
    // 2 meaningful tokens each, one shared → Dice 0.5, which would clear a naive
    // 0.5 cutoff; the short-title rule demands the same set instead.
    expect(CORROBORATION_TUNING.minTokensForFuzzy).toBeGreaterThan(2);
    expect(titlesCorroborate('unsafe unwrap', 'unsafe cast')).toBe(false);
    expect(titlesCorroborate('unsafe unwrap', 'the unsafe unwrap')).toBe(true);
  });
});

describe('corroboratePrReviewFindings', () => {
  test('corroborates near-duplicate findings from DIFFERENT lenses on the same file', () => {
    const out = corroboratePrReviewFindings([
      finding('security', 'src/a.ts', 'Missing null check on the parsed config', 'high'),
      finding('logic', 'src/a.ts', 'Parsed config is missing a null check', 'low'),
    ]);
    expect(out).toHaveLength(1);
    // The HIGHER-severity instance survives, with its severity untouched.
    expect(out[0]?.lens).toBe('security');
    expect(out[0]?.severity).toBe('high');
    expect(out[0]?.corroboratedBy).toEqual(['logic']);
  });

  test('never merges SAME-lens near-duplicates (that is ordinary dedup)', () => {
    const out = corroboratePrReviewFindings([
      finding('logic', 'src/a.ts', 'Missing null check on the parsed config'),
      finding('logic', 'src/a.ts', 'Parsed config is missing a null check'),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((f) => f.corroboratedBy === undefined)).toBe(true);
  });

  test('does not corroborate across DIFFERENT files even with identical titles', () => {
    const out = corroboratePrReviewFindings([
      finding('security', 'src/a.ts', 'Missing null check on the parsed config'),
      finding('logic', 'src/b.ts', 'Missing null check on the parsed config'),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((f) => f.corroboratedBy === undefined)).toBe(true);
  });

  test('leaves dissimilar findings separate and uncorroborated', () => {
    const out = corroboratePrReviewFindings([
      finding('security', 'src/a.ts', 'Command injection via unsanitized argv'),
      finding('tests', 'src/a.ts', 'New branch has no regression test coverage'),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((f) => f.corroboratedBy === undefined)).toBe(true);
  });

  test('unions three lenses and preserves corroborators recorded by the exact dedup', () => {
    const out = corroboratePrReviewFindings([
      finding('security', 'src/a.ts', 'Missing null check on the parsed config', 'medium', {
        // Already collapsed with an exact-title `contracts` twin upstream.
        corroboratedBy: ['contracts'],
      }),
      finding('logic', 'src/a.ts', 'Parsed config is missing a null check', 'medium'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.corroboratedBy).toEqual(['contracts', 'logic']);
    expect(corroborationCount(out[0] as ReviewFinding)).toBe(3);
  });

  test('never mutates a severity — the clamp sees the same worst severity', () => {
    const input = [
      finding('security', 'src/a.ts', 'Missing null check on the parsed config', 'low'),
      finding('logic', 'src/a.ts', 'Parsed config is missing a null check', 'low'),
    ];
    const out = corroboratePrReviewFindings(input);
    expect(out.map((f) => f.severity)).toEqual(['low']);
    // The input array is untouched (pure).
    expect(input.map((f) => f.severity)).toEqual(['low', 'low']);
  });

  test('is order-stable on each cluster first appearance', () => {
    const out = corroboratePrReviewFindings([
      finding('structure', 'src/z.ts', 'Duplicated helper across modules'),
      finding('security', 'src/a.ts', 'Missing null check on the parsed config'),
      finding('logic', 'src/a.ts', 'Parsed config is missing a null check'),
    ]);
    expect(out.map((f) => f.file)).toEqual(['src/z.ts', 'src/a.ts']);
  });
});

describe('rankPrReviewFindings', () => {
  test('KEEPS EVERY finding — ranking never caps, suppresses, or demotes', () => {
    const input = [
      finding('logic', 'a.ts', 'one', 'low'),
      finding('logic', 'b.ts', 'two', 'low'),
      finding('logic', 'c.ts', 'three', 'info'),
      finding('logic', 'd.ts', 'four', 'info'),
    ];
    expect(rankPrReviewFindings(input)).toHaveLength(input.length);
  });

  test('sorts severity desc, then corroboration count desc, then lens order', () => {
    const out = rankPrReviewFindings([
      finding('tests', 'a.ts', 'low-solo', 'low'),
      finding('logic', 'b.ts', 'high-solo', 'high'),
      finding('tests', 'c.ts', 'high-corroborated', 'high', {
        corroboratedBy: ['security'],
      }),
      finding('security', 'd.ts', 'critical', 'critical'),
    ]);
    expect(out.map((f) => f.title)).toEqual([
      'critical',
      // Both high; the corroborated one outranks the solo one.
      'high-corroborated',
      'high-solo',
      'low-solo',
    ]);
  });

  test('breaks a full tie by lens declaration order, then input order', () => {
    const out = rankPrReviewFindings([
      finding('contracts', 'a.ts', 'c', 'medium'),
      finding('security', 'b.ts', 's', 'medium'),
      finding('logic', 'c.ts', 'l', 'medium'),
    ]);
    expect(out.map((f) => f.lens)).toEqual(['security', 'logic', 'contracts']);
  });

  test('returns a new array and leaves the input order untouched', () => {
    const input = [
      finding('logic', 'a.ts', 'low', 'low'),
      finding('logic', 'b.ts', 'high', 'high'),
    ];
    const out = rankPrReviewFindings(input);
    expect(out).not.toBe(input);
    expect(input.map((f) => f.title)).toEqual(['low', 'high']);
  });
});
