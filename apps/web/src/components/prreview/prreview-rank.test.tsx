import { describe, expect, it } from 'vitest';

import type { ReviewFindingView } from './prreview.types';
import { corroborationCount, rankReviewFindings } from './prreview-rank';

function view(over: Partial<ReviewFindingView> = {}): ReviewFindingView {
  return {
    id: 'f1',
    lens: 'logic',
    severity: 'medium',
    file: 'src/a.ts',
    line: 1,
    title: 't',
    body: 'b',
    suggestedFix: null,
    fingerprint: 'fp1',
    corroboratedBy: [],
    status: 'open',
    linkedTaskId: null,
    ...over,
  };
}

describe('corroborationCount', () => {
  it('counts the reporting lens plus its corroborators', () => {
    expect(corroborationCount(view())).toBe(1);
    expect(corroborationCount(view({ corroboratedBy: ['security', 'tests'] }))).toBe(3);
  });
});

describe('rankReviewFindings', () => {
  it('KEEPS every finding — ranking never caps or suppresses', () => {
    const input = [
      view({ id: 'a', severity: 'info' }),
      view({ id: 'b', severity: 'low' }),
      view({ id: 'c', severity: 'low' }),
      view({ id: 'd', severity: 'critical' }),
    ];
    expect(rankReviewFindings(input).map((f) => f.id).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('ranks open before resolved, then severity high→low', () => {
    const out = rankReviewFindings([
      view({ id: 'dismissed-critical', severity: 'critical', status: 'dismissed' }),
      view({ id: 'open-low', severity: 'low' }),
      view({ id: 'open-high', severity: 'high' }),
    ]);
    expect(out.map((f) => f.id)).toEqual([
      'open-high',
      'open-low',
      'dismissed-critical',
    ]);
  });

  it('ranks a corroborated finding above a solo one of the SAME severity', () => {
    const out = rankReviewFindings([
      view({ id: 'solo', severity: 'medium' }),
      view({ id: 'agreed', severity: 'medium', corroboratedBy: ['security'] }),
    ]);
    expect(out.map((f) => f.id)).toEqual(['agreed', 'solo']);
  });

  it('never lets corroboration outrank severity', () => {
    const out = rankReviewFindings([
      view({ id: 'low-agreed-by-three', severity: 'low', corroboratedBy: ['security', 'tests'] }),
      view({ id: 'high-solo', severity: 'high' }),
    ]);
    expect(out.map((f) => f.id)).toEqual(['high-solo', 'low-agreed-by-three']);
  });

  it('breaks a full tie by lens display order, then input order', () => {
    const out = rankReviewFindings([
      view({ id: 'contracts', lens: 'contracts' }),
      view({ id: 'security', lens: 'security' }),
      view({ id: 'logic-2', lens: 'logic' }),
      view({ id: 'logic-1', lens: 'logic' }),
    ]);
    expect(out.map((f) => f.id)).toEqual([
      'security',
      'logic-2',
      'logic-1',
      'contracts',
    ]);
  });

  it('returns a new array and leaves the input untouched', () => {
    const input = [view({ id: 'low', severity: 'low' }), view({ id: 'high', severity: 'high' })];
    const out = rankReviewFindings(input);
    expect(out).not.toBe(input);
    expect(input.map((f) => f.id)).toEqual(['low', 'high']);
  });
});
