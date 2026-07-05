import { describe, expect, it } from 'vitest';

import type {
  PrReviewRun,
  ReviewFinding,
  StoredReviewFinding,
} from '@/lib/bridge';

import {
  EMPTY_REVIEW_STREAM,
  foldReview,
  type PrReviewLensEvent,
  type ReviewStream,
  storedToFinding,
  streamFromRun,
  wireToFinding,
} from './prreview-stream';

function wireFinding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'f1',
    lens: 'logic',
    severity: 'high',
    file: 'src/a.ts',
    title: 'Unawaited promise',
    body: 'drops errors',
    fingerprint: 'fp1',
    ...over,
  };
}

const USAGE = { inputTokens: 100, outputTokens: 50 };

describe('foldReview', () => {
  it('pr-review-started resets to a running stream with pending lenses', () => {
    const next = foldReview(EMPTY_REVIEW_STREAM, {
      type: 'pr-review-started',
      runId: 'run-1',
      lenses: ['security', 'logic'],
      model: 'claude-opus-4-8',
    } as PrReviewLensEvent);
    expect(next.runId).toBe('run-1');
    expect(next.status).toBe('running');
    expect(next.requestedLenses).toEqual(['security', 'logic']);
    expect(next.lensState).toEqual({ security: 'pending', logic: 'pending' });
  });

  it('pr-review-started preserves the optimistically-set PR number', () => {
    const base: ReviewStream = { ...EMPTY_REVIEW_STREAM, prNumber: 42 };
    const next = foldReview(base, {
      type: 'pr-review-started',
      runId: 'run-1',
      lenses: ['logic'],
      model: 'm',
    } as PrReviewLensEvent);
    expect(next.prNumber).toBe(42);
  });

  it('pr-review-lens-started marks that lens running', () => {
    const start = foldReview(EMPTY_REVIEW_STREAM, {
      type: 'pr-review-started',
      runId: 'run-1',
      lenses: ['logic'],
      model: 'm',
    } as PrReviewLensEvent);
    const next = foldReview(start, {
      type: 'pr-review-lens-started',
      runId: 'run-1',
      lens: 'logic',
    } as PrReviewLensEvent);
    expect(next.lensState.logic).toBe('running');
  });

  it('pr-review-lens-completed appends findings and accumulates cost/usage', () => {
    const base: ReviewStream = {
      ...EMPTY_REVIEW_STREAM,
      runId: 'run-1',
      status: 'running',
      requestedLenses: ['logic'],
      lensState: { logic: 'running' },
    };
    const next = foldReview(base, {
      type: 'pr-review-lens-completed',
      runId: 'run-1',
      lens: 'logic',
      findings: [wireFinding()],
      usage: USAGE,
      costUsd: 0.04,
    } as PrReviewLensEvent);
    expect(next.findings).toHaveLength(1);
    expect(next.findings[0]?.status).toBe('open');
    expect(next.lensState.logic).toBe('done');
    expect(next.costUsd).toBeCloseTo(0.04);
    expect(next.usage.inputTokens).toBe(100);
  });

  it('pr-review-lens-completed with an error marks the lens errored', () => {
    const base: ReviewStream = {
      ...EMPTY_REVIEW_STREAM,
      runId: 'run-1',
      status: 'running',
      lensState: { logic: 'running' },
    };
    const next = foldReview(base, {
      type: 'pr-review-lens-completed',
      runId: 'run-1',
      lens: 'logic',
      findings: [],
      costUsd: 0,
      error: 'no JSON',
    } as PrReviewLensEvent);
    expect(next.lensState.logic).toBe('error');
  });

  it('a re-emitted lens replaces only that lens’s findings', () => {
    let s: ReviewStream = {
      ...EMPTY_REVIEW_STREAM,
      runId: 'run-1',
      status: 'running',
    };
    s = foldReview(s, {
      type: 'pr-review-lens-completed',
      runId: 'run-1',
      lens: 'logic',
      findings: [wireFinding({ id: 'l1', fingerprint: 'l1' })],
      costUsd: 0,
    } as PrReviewLensEvent);
    s = foldReview(s, {
      type: 'pr-review-lens-completed',
      runId: 'run-1',
      lens: 'security',
      findings: [wireFinding({ id: 's1', lens: 'security', fingerprint: 's1' })],
      costUsd: 0,
    } as PrReviewLensEvent);
    expect(s.findings.map((f) => f.id).sort()).toEqual(['l1', 's1']);
  });

  it('pr-review-completed sets the final findings + totals and marks all done', () => {
    const base: ReviewStream = {
      ...EMPTY_REVIEW_STREAM,
      runId: 'run-1',
      status: 'running',
      requestedLenses: ['logic', 'security'],
      lensState: { logic: 'done', security: 'error' },
    };
    const next = foldReview(base, {
      type: 'pr-review-completed',
      runId: 'run-1',
      findings: [wireFinding()],
      lensesRun: 2,
      costUsd: 0.12,
      durationMs: 45000,
      usage: USAGE,
    } as PrReviewLensEvent);
    expect(next.status).toBe('completed');
    expect(next.findings).toHaveLength(1);
    expect(next.durationMs).toBe(45000);
    // An errored lens stays errored; others become done.
    expect(next.lensState.security).toBe('error');
    expect(next.lensState.logic).toBe('done');
  });

  it('pr-review-failed records the error and carries the abort reason', () => {
    const next = foldReview(
      { ...EMPTY_REVIEW_STREAM, runId: 'run-1', status: 'running' },
      {
        type: 'pr-review-failed',
        runId: 'run-1',
        reason: 'aborted',
        message: 'cancelled',
      } as PrReviewLensEvent,
    );
    expect(next.status).toBe('failed');
    expect(next.error).toBe('cancelled');
    // The reason threads through so the view can show a neutral cancel notice
    // instead of the destructive failure banner.
    expect(next.failureReason).toBe('aborted');
  });
});

describe('normalizers', () => {
  it('wireToFinding maps a contract ReviewFinding to the open view shape', () => {
    const f = wireToFinding(
      wireFinding({ line: 10, suggestedFix: 'await it' }),
    );
    expect(f.status).toBe('open');
    expect(f.linkedTaskId).toBeNull();
    expect(f.line).toBe(10);
    expect(f.suggestedFix).toBe('await it');
  });

  it('wireToFinding defaults an absent line + suggestedFix to null', () => {
    const f = wireToFinding(wireFinding());
    expect(f.line).toBeNull();
    expect(f.suggestedFix).toBeNull();
  });

  it('wireToFinding carries corroboratedBy through, defaulting absent to []', () => {
    expect(wireToFinding(wireFinding()).corroboratedBy).toEqual([]);
    expect(
      wireToFinding(wireFinding({ corroboratedBy: ['security', 'tests'] }))
        .corroboratedBy,
    ).toEqual(['security', 'tests']);
  });

  it('storedToFinding narrows the persisted string fields to unions', () => {
    const stored: StoredReviewFinding = {
      id: 'f1',
      lens: 'security',
      severity: 'critical',
      file: 'src/a.ts',
      line: null,
      title: 't',
      body: 'b',
      suggestedFix: null,
      fingerprint: 'fp',
      corroboratedBy: null,
      status: 'dismissed',
      linkedTaskId: null,
    };
    const f = storedToFinding(stored);
    expect(f.lens).toBe('security');
    expect(f.status).toBe('dismissed');
    // A null corroboratedBy coerces to [] (older engine / uncorroborated).
    expect(f.corroboratedBy).toEqual([]);
  });

  it('storedToFinding narrows the corroboratedBy wire strings to the lens union', () => {
    const stored: StoredReviewFinding = {
      id: 'f1',
      lens: 'security',
      severity: 'high',
      file: 'src/a.ts',
      line: null,
      title: 't',
      body: 'b',
      suggestedFix: null,
      fingerprint: 'fp',
      corroboratedBy: ['logic', 'tests'],
      status: 'open',
      linkedTaskId: null,
    };
    expect(storedToFinding(stored).corroboratedBy).toEqual(['logic', 'tests']);
  });

  it('streamFromRun projects a completed persisted run into the stream shape', () => {
    const run: PrReviewRun = {
      id: 'run-1',
      projectPath: '/proj',
      prNumber: 7,
      status: 'completed',
      lenses: ['logic'],
      model: 'm',
      createdAt: 1,
      updatedAt: 2,
      costUsd: 0.5,
      durationMs: 1000,
      usage: { inputTokens: 10, outputTokens: 5 },
      findings: [],
      error: null,
      verdict: null,
      verdictReasoning: null,
      headSha: null,
      postedVerdict: null,
      postedAt: null,
    };
    const s = streamFromRun(run);
    expect(s.status).toBe('completed');
    expect(s.prNumber).toBe(7);
    expect(s.lensState.logic).toBe('done');
    expect(s.costUsd).toBe(0.5);
  });
});
