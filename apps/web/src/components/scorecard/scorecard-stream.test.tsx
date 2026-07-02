import { describe, expect, it } from 'vitest';

import type { ScorecardReading, ScorecardRun } from '@/lib/bridge';

import {
  EMPTY_SCORECARD_STREAM,
  foldScorecard,
  storedToReading,
  streamFromRun,
  wireToReading,
} from './scorecard-stream';

function wireReading(over: Partial<ScorecardReading> = {}): ScorecardReading {
  return {
    id: 'security-1',
    dimension: 'security',
    grade: 'C',
    title: 'Input validation gaps',
    summary: 'Handlers trust unvalidated bodies',
    affectedFiles: [],
    tags: [],
    findings: [],
    fingerprint: 'fp1',
    ...over,
  };
}

const USAGE = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

describe('foldScorecard', () => {
  it('scorecard-started resets to a running stream with pending dimensions', () => {
    const next = foldScorecard(EMPTY_SCORECARD_STREAM, {
      type: 'scorecard-started',
      runId: 'run-1',
      dimensions: ['security', 'tests'],
      model: 'claude-opus-4-8',
    });
    expect(next.status).toBe('running');
    expect(next.runId).toBe('run-1');
    expect(next.dimensionState).toEqual({ security: 'pending', tests: 'pending' });
  });

  it('scorecard-dimension-started marks the dimension running', () => {
    const next = foldScorecard(
      { ...EMPTY_SCORECARD_STREAM, requestedDimensions: ['security'] },
      { type: 'scorecard-dimension-started', runId: 'r', dimension: 'security' },
    );
    expect(next.dimensionState.security).toBe('running');
  });

  it('scorecard-dimension-completed stores the reading and accrues cost/usage', () => {
    const next = foldScorecard(
      { ...EMPTY_SCORECARD_STREAM, costUsd: 0.01 },
      {
        type: 'scorecard-dimension-completed',
        runId: 'r',
        dimension: 'security',
        reading: wireReading({ grade: 'D' }),
        usage: USAGE,
        costUsd: 0.04,
      },
    );
    expect(next.dimensionState.security).toBe('done');
    expect(next.readings).toHaveLength(1);
    expect(next.readings[0]?.grade).toBe('D');
    expect(next.costUsd).toBeCloseTo(0.05, 6);
    expect(next.usage.inputTokens).toBe(100);
  });

  it('an errored dimension completion marks it error with no reading', () => {
    const next = foldScorecard(EMPTY_SCORECARD_STREAM, {
      type: 'scorecard-dimension-completed',
      runId: 'r',
      dimension: 'tests',
      error: 'boom',
      costUsd: 0,
    });
    expect(next.dimensionState.tests).toBe('error');
    expect(next.readings).toHaveLength(0);
  });

  it('scorecard-completed replaces readings and marks completed', () => {
    const next = foldScorecard(
      { ...EMPTY_SCORECARD_STREAM, requestedDimensions: ['security'] },
      {
        type: 'scorecard-completed',
        runId: 'r',
        readings: [wireReading({ grade: 'A' })],
        dimensionsRun: ['security'],
        costUsd: 0.1,
        durationMs: 1234,
        usage: USAGE,
      },
    );
    expect(next.status).toBe('completed');
    expect(next.readings[0]?.grade).toBe('A');
    expect(next.durationMs).toBe(1234);
  });

  it('scorecard-failed threads the reason through for the cancel banner', () => {
    const next = foldScorecard(EMPTY_SCORECARD_STREAM, {
      type: 'scorecard-failed',
      runId: 'r',
      reason: 'aborted',
      message: 'cancelled',
    });
    expect(next.status).toBe('failed');
    expect(next.failureReason).toBe('aborted');
    expect(next.error).toBe('cancelled');
  });
});

describe('reading normalizers', () => {
  it('wireToReading is always open + unlinked', () => {
    const v = wireToReading(wireReading());
    expect(v.status).toBe('open');
    expect(v.linkedTaskId).toBeNull();
  });

  it('storedToReading narrows the persisted lifecycle fields', () => {
    const stored = {
      id: 'security-1',
      dimension: 'security',
      grade: 'B',
      title: 't',
      summary: 's',
      rationale: null,
      location: null,
      suggestion: null,
      affectedFiles: [],
      tags: [],
      findings: [{ detail: 'd', location: null }],
      confidence: null,
      fingerprint: 'fp',
      status: 'converted',
      linkedTaskId: 'task-1',
    };
    const v = storedToReading(stored);
    expect(v.status).toBe('converted');
    expect(v.linkedTaskId).toBe('task-1');
    expect(v.findings[0]?.detail).toBe('d');
  });

  it('streamFromRun projects a completed run with all dimensions done', () => {
    const run: ScorecardRun = {
      id: 'r',
      projectPath: '/p',
      status: 'completed',
      dimensions: ['security', 'tests'],
      model: 'm',
      createdAt: 1,
      updatedAt: 1,
      costUsd: 0.2,
      durationMs: 9,
      usage: { inputTokens: 1, outputTokens: 2 },
      readings: [],
      error: null,
    };
    const s = streamFromRun(run);
    expect(s.status).toBe('completed');
    expect(s.dimensionState).toEqual({ security: 'done', tests: 'done' });
  });
});
