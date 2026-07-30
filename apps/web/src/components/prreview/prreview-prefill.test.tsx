import { describe, expect, it } from 'vitest';

import type { ReviewFindingView } from './prreview.types';
import { recommendedReviewVerdict, splitForPosting } from './prreview-prefill';

function view(over: Partial<ReviewFindingView> = {}): ReviewFindingView {
  return {
    id: 'f1',
    lens: 'logic',
    severity: 'medium',
    file: 'src/a.ts',
    line: 10,
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

describe('recommendedReviewVerdict', () => {
  it('maps each clamped merge verdict onto a GitHub review verdict', () => {
    expect(recommendedReviewVerdict('ready', false)).toBe('approve');
    expect(recommendedReviewVerdict('merge_with_changes', false)).toBe('comment');
    expect(recommendedReviewVerdict('needs_revision', false)).toBe('request-changes');
    expect(recommendedReviewVerdict('blocked', false)).toBe('request-changes');
  });

  it('a lows-only run (merge_with_changes) never pre-fills a blocking verdict', () => {
    expect(recommendedReviewVerdict('merge_with_changes', false)).not.toBe(
      'request-changes',
    );
  });

  it('falls back to comment with no verdict, or an unknown one', () => {
    expect(recommendedReviewVerdict(null, false)).toBe('comment');
    expect(recommendedReviewVerdict('something-else', false)).toBe('comment');
  });

  it('never recommends a verdict GitHub rejects on your OWN pull request', () => {
    expect(recommendedReviewVerdict('ready', true)).toBe('comment');
    expect(recommendedReviewVerdict('blocked', true)).toBe('comment');
    expect(recommendedReviewVerdict('merge_with_changes', true)).toBe('comment');
  });
});

describe('splitForPosting', () => {
  it('pre-selects high-signal anchored findings as inline comments', () => {
    const { inline, body } = splitForPosting([
      view({ id: 'crit', severity: 'critical' }),
      view({ id: 'high', severity: 'high' }),
      view({ id: 'med', severity: 'medium' }),
    ]);
    expect(inline.map((f) => f.id)).toEqual(['crit', 'high', 'med']);
    expect(body).toHaveLength(0);
  });

  it('keeps lows and info in the review body note', () => {
    const { inline, body } = splitForPosting([
      view({ id: 'low', severity: 'low' }),
      view({ id: 'info', severity: 'info' }),
    ]);
    expect(inline).toHaveLength(0);
    expect(body.map((f) => f.id)).toEqual(['low', 'info']);
  });

  it('promotes a CORROBORATED low — two lenses agreeing is real signal', () => {
    const { inline } = splitForPosting([
      view({ id: 'agreed-low', severity: 'low', corroboratedBy: ['security'] }),
    ]);
    expect(inline.map((f) => f.id)).toEqual(['agreed-low']);
  });

  it('demotes an un-anchorable finding no matter how severe', () => {
    const { inline, body } = splitForPosting([
      view({ id: 'no-line', severity: 'critical', line: null }),
    ]);
    expect(inline).toHaveLength(0);
    expect(body.map((f) => f.id)).toEqual(['no-line']);
  });

  it('allInline promotes every ANCHORABLE finding (and only those)', () => {
    const { inline, body } = splitForPosting(
      [
        view({ id: 'low', severity: 'low' }),
        view({ id: 'no-line', severity: 'low', line: null }),
      ],
      true,
    );
    expect(inline.map((f) => f.id)).toEqual(['low']);
    expect(body.map((f) => f.id)).toEqual(['no-line']);
  });

  it('never DROPS a selected finding — every one lands in exactly one half', () => {
    const findings = [
      view({ id: 'a', severity: 'critical' }),
      view({ id: 'b', severity: 'low' }),
      view({ id: 'c', severity: 'info', line: null }),
      view({ id: 'd', severity: 'high', corroboratedBy: ['tests'] }),
    ];
    const { inline, body } = splitForPosting(findings);
    expect([...inline, ...body].map((f) => f.id).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});
