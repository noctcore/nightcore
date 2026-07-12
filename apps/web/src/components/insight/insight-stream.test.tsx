import { describe, expect, it } from 'vitest';

import type {
  AnalysisEvent,
  Finding,
  InsightRun,
  StoredFinding,
} from '@/lib/bridge';

import {
  EMPTY_INSIGHT_STREAM,
  foldInsight,
  type InsightStream,
  storedToFinding,
  streamFromRun,
  wireToFinding,
} from './insight-stream';

function wireFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    category: 'bugs',
    severity: 'high',
    effort: 'small',
    title: 'Unawaited promise',
    description: 'drops errors',
    affectedFiles: [],
    tags: [],
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

describe('foldInsight', () => {
  it('analysis-started resets to a running stream with pending categories', () => {
    const next = foldInsight(EMPTY_INSIGHT_STREAM, {
      type: 'analysis-started',
      runId: 'run-1',
      scope: 'repo',
      categories: ['bugs', 'security'],
      model: 'claude-opus-4-8',
    } as AnalysisEvent);
    expect(next.runId).toBe('run-1');
    expect(next.status).toBe('running');
    expect(next.requestedCategories).toEqual(['bugs', 'security']);
    expect(next.categoryState).toEqual({ bugs: 'pending', security: 'pending' });
  });

  it('category-started marks that category running', () => {
    const start = foldInsight(EMPTY_INSIGHT_STREAM, {
      type: 'analysis-started',
      runId: 'run-1',
      scope: 'repo',
      categories: ['bugs'],
      model: 'm',
    } as AnalysisEvent);
    const next = foldInsight(start, {
      type: 'analysis-category-started',
      runId: 'run-1',
      category: 'bugs',
    } as AnalysisEvent);
    expect(next.categoryState.bugs).toBe('running');
  });

  it('category-completed appends grounded findings and accumulates cost/usage', () => {
    const base: InsightStream = {
      ...EMPTY_INSIGHT_STREAM,
      runId: 'run-1',
      status: 'running',
      requestedCategories: ['bugs'],
      categoryState: { bugs: 'running' },
    };
    const next = foldInsight(base, {
      type: 'analysis-category-completed',
      runId: 'run-1',
      category: 'bugs',
      findings: [wireFinding()],
      usage: USAGE,
      costUsd: 0.04,
    } as AnalysisEvent);
    expect(next.findings).toHaveLength(1);
    expect(next.findings[0]?.status).toBe('open');
    expect(next.categoryState.bugs).toBe('done');
    expect(next.costUsd).toBeCloseTo(0.04);
    expect(next.usage.inputTokens).toBe(100);
  });

  it('category-completed with an error marks the category errored', () => {
    const base: InsightStream = {
      ...EMPTY_INSIGHT_STREAM,
      runId: 'run-1',
      status: 'running',
      categoryState: { bugs: 'running' },
    };
    const next = foldInsight(base, {
      type: 'analysis-category-completed',
      runId: 'run-1',
      category: 'bugs',
      findings: [],
      costUsd: 0,
      error: 'no JSON',
    } as AnalysisEvent);
    expect(next.categoryState.bugs).toBe('error');
  });

  it('a re-emitted category replaces only that category’s findings', () => {
    let s: InsightStream = {
      ...EMPTY_INSIGHT_STREAM,
      runId: 'run-1',
      status: 'running',
    };
    s = foldInsight(s, {
      type: 'analysis-category-completed',
      runId: 'run-1',
      category: 'bugs',
      findings: [wireFinding({ id: 'b1', fingerprint: 'b1' })],
      costUsd: 0,
    } as AnalysisEvent);
    s = foldInsight(s, {
      type: 'analysis-category-completed',
      runId: 'run-1',
      category: 'security',
      findings: [wireFinding({ id: 's1', category: 'security', fingerprint: 's1' })],
      costUsd: 0,
    } as AnalysisEvent);
    expect(s.findings.map((f) => f.id).sort()).toEqual(['b1', 's1']);
  });

  it('a round-completed event grows findings, accumulates cost/usage, and keeps the category running', () => {
    const base: InsightStream = {
      ...EMPTY_INSIGHT_STREAM,
      runId: 'run-1',
      status: 'running',
      requestedCategories: ['bugs'],
      categoryState: { bugs: 'running' },
    };
    const round1 = foldInsight(base, {
      type: 'analysis-category-round-completed',
      runId: 'run-1',
      category: 'bugs',
      round: 1,
      newFindingsThisRound: 1,
      findings: [wireFinding({ id: 'b1', fingerprint: 'b1' })],
      usage: USAGE,
      costUsd: 0.02,
      durationMs: 5000,
    } as AnalysisEvent);
    expect(round1.findings).toHaveLength(1);
    // Deep mode never emits a per-category terminal event — the round leaves the
    // category `running` (not `done`) so the UI doesn't wait on an event that
    // never comes.
    expect(round1.categoryState.bugs).toBe('running');
    expect(round1.categoryRounds.bugs).toEqual({ round: 1, newFindingsThisRound: 1 });
    expect(round1.costUsd).toBeCloseTo(0.02);
    expect(round1.usage.inputTokens).toBe(100);

    // A second round's CUMULATIVE findings replace (not append to) the category's
    // slice — the grid grows as rounds land, but stays de-duplicated per round.
    const round2 = foldInsight(round1, {
      type: 'analysis-category-round-completed',
      runId: 'run-1',
      category: 'bugs',
      round: 2,
      newFindingsThisRound: 1,
      findings: [
        wireFinding({ id: 'b1', fingerprint: 'b1' }),
        wireFinding({ id: 'b2', fingerprint: 'b2' }),
      ],
      usage: USAGE,
      costUsd: 0.03,
      durationMs: 4000,
    } as AnalysisEvent);
    expect(round2.findings.map((f) => f.id).sort()).toEqual(['b1', 'b2']);
    expect(round2.categoryRounds.bugs).toEqual({ round: 2, newFindingsThisRound: 1 });
    expect(round2.costUsd).toBeCloseTo(0.05);
  });

  it('a round-completed event for one category leaves another category’s findings alone', () => {
    let s: InsightStream = {
      ...EMPTY_INSIGHT_STREAM,
      runId: 'run-1',
      status: 'running',
      requestedCategories: ['bugs', 'security'],
      categoryState: { bugs: 'running', security: 'running' },
    };
    s = foldInsight(s, {
      type: 'analysis-category-round-completed',
      runId: 'run-1',
      category: 'security',
      round: 1,
      newFindingsThisRound: 1,
      findings: [wireFinding({ id: 's1', category: 'security', fingerprint: 's1' })],
      costUsd: 0,
    } as AnalysisEvent);
    s = foldInsight(s, {
      type: 'analysis-category-round-completed',
      runId: 'run-1',
      category: 'bugs',
      round: 1,
      newFindingsThisRound: 1,
      findings: [wireFinding({ id: 'b1', fingerprint: 'b1' })],
      costUsd: 0,
    } as AnalysisEvent);
    expect(s.findings.map((f) => f.id).sort()).toEqual(['b1', 's1']);
    expect(s.categoryRounds).toEqual({
      security: { round: 1, newFindingsThisRound: 1 },
      bugs: { round: 1, newFindingsThisRound: 1 },
    });
  });

  it('analysis-completed sets the final findings + totals and marks all done', () => {
    const base: InsightStream = {
      ...EMPTY_INSIGHT_STREAM,
      runId: 'run-1',
      status: 'running',
      requestedCategories: ['bugs', 'security'],
      categoryState: { bugs: 'done', security: 'error' },
    };
    const next = foldInsight(base, {
      type: 'analysis-completed',
      runId: 'run-1',
      findings: [wireFinding()],
      categoriesRun: ['bugs', 'security'],
      costUsd: 0.12,
      durationMs: 45000,
      usage: USAGE,
    } as AnalysisEvent);
    expect(next.status).toBe('completed');
    expect(next.findings).toHaveLength(1);
    expect(next.durationMs).toBe(45000);
    // An errored category stays errored; others become done.
    expect(next.categoryState.security).toBe('error');
    expect(next.categoryState.bugs).toBe('done');
  });

  it('analysis-failed records the error and carries the abort reason', () => {
    const next = foldInsight(
      { ...EMPTY_INSIGHT_STREAM, runId: 'run-1', status: 'running' },
      {
        type: 'analysis-failed',
        runId: 'run-1',
        reason: 'aborted',
        message: 'cancelled',
      } as AnalysisEvent,
    );
    expect(next.status).toBe('failed');
    expect(next.error).toBe('cancelled');
    // The reason threads through so the view can show a neutral cancel notice
    // instead of the destructive failure banner.
    expect(next.failureReason).toBe('aborted');
  });

  it('analysis-failed carries a non-abort crash reason', () => {
    const next = foldInsight(
      { ...EMPTY_INSIGHT_STREAM, runId: 'run-1', status: 'running' },
      {
        type: 'analysis-failed',
        runId: 'run-1',
        reason: 'runner-crash',
        message: 'boom',
      } as AnalysisEvent,
    );
    expect(next.failureReason).toBe('runner-crash');
  });
});

describe('normalizers', () => {
  it('wireToFinding maps a contract Finding to the open view shape', () => {
    const f = wireToFinding(
      wireFinding({
        location: { file: 'src/a.ts', startLine: 10 },
        suggestion: 'await it',
      }),
    );
    expect(f.status).toBe('open');
    expect(f.linkedTaskId).toBeNull();
    expect(f.location?.startLine).toBe(10);
    expect(f.location?.endLine).toBeNull();
    expect(f.suggestion).toBe('await it');
  });

  it('storedToFinding narrows the persisted string fields to unions', () => {
    const stored: StoredFinding = {
      id: 'f1',
      category: 'security',
      severity: 'critical',
      effort: 'large',
      title: 't',
      description: 'd',
      rationale: null,
      location: null,
      suggestion: null,
      codeBefore: null,
      codeAfter: null,
      affectedFiles: [],
      tags: [],
      confidence: null,
      fingerprint: 'fp',
      status: 'dismissed',
      linkedTaskId: null,
    };
    const f = storedToFinding(stored);
    expect(f.category).toBe('security');
    expect(f.status).toBe('dismissed');
  });

  it('streamFromRun projects a completed persisted run into the stream shape', () => {
    const run: InsightRun = {
      id: 'run-1',
      projectPath: '/proj',
      scope: 'diff',
      status: 'completed',
      categories: ['bugs'],
      model: 'm',
      createdAt: 1,
      updatedAt: 2,
      costUsd: 0.5,
      durationMs: 1000,
      usage: { inputTokens: 10, outputTokens: 5 },
      findings: [],
      roundsByCategory: {},
      error: null,
    };
    const s = streamFromRun(run);
    expect(s.status).toBe('completed');
    expect(s.scope).toBe('diff');
    expect(s.categoryState.bugs).toBe('done');
    expect(s.costUsd).toBe(0.5);
    expect(s.categoryRounds).toEqual({});
  });

  it('streamFromRun projects a deep run’s persisted round counts into categoryRounds', () => {
    const run: InsightRun = {
      id: 'run-1',
      projectPath: '/proj',
      scope: 'repo',
      status: 'completed',
      categories: ['bugs', 'security'],
      model: 'm',
      createdAt: 1,
      updatedAt: 2,
      costUsd: 1.2,
      durationMs: 60000,
      usage: { inputTokens: 100, outputTokens: 50 },
      findings: [],
      roundsByCategory: { bugs: 4, security: 2 },
      error: null,
    };
    const s = streamFromRun(run);
    // `newFindingsThisRound` isn't persisted — a reloaded run reports 0 for it.
    expect(s.categoryRounds).toEqual({
      bugs: { round: 4, newFindingsThisRound: 0 },
      security: { round: 2, newFindingsThisRound: 0 },
    });
  });

  it('storedToFinding degrades corrupt enum fields to their neutral fallbacks', () => {
    const stored: StoredFinding = {
      id: 'f1',
      category: 'not-a-category',
      severity: 'apocalyptic',
      effort: 'herculean',
      title: 't',
      description: 'd',
      rationale: null,
      location: null,
      suggestion: null,
      codeBefore: null,
      codeAfter: null,
      affectedFiles: [],
      tags: [],
      confidence: null,
      fingerprint: 'fp',
      status: 'garbled',
      linkedTaskId: null,
    };
    const f = storedToFinding(stored);
    // Nothing corrupt leaks into the VM — each field falls back.
    expect(f.category).toBe('refactor');
    expect(f.severity).toBe('info');
    expect(f.effort).toBe('medium');
    expect(f.status).toBe('open');
  });

  it('streamFromRun drops an unknown category and falls back a corrupt scope', () => {
    const run: InsightRun = {
      id: 'run-1',
      projectPath: '/proj',
      scope: 'sideways',
      status: 'completed',
      categories: ['bugs', 'fictional', 'security'],
      model: 'm',
      createdAt: 1,
      updatedAt: 2,
      costUsd: 0,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      findings: [],
      roundsByCategory: {},
      error: null,
    };
    const s = streamFromRun(run);
    expect(s.scope).toBe('repo');
    expect(s.requestedCategories).toEqual(['bugs', 'security']);
    expect(s.categoryState).toEqual({ bugs: 'done', security: 'done' });
  });
});
