import { describe, expect, it } from 'vitest';

import type { PrReviewEvent, PrReviewRun, ReviewFinding } from '@/lib/bridge';

import type { FindingStatus } from './prreview.types';
import {
  EMPTY_RUN_REGISTRY,
  findingCountForPr,
  foldRegistry,
  historyForPr,
  latestRunForPr,
  type PrReviewRunEntry,
  type PrReviewRunRegistry,
  reconcileRegistryRun,
  runningPrNumbers,
} from './prreview-runs';
import { EMPTY_REVIEW_STREAM, type ReviewStream } from './prreview-stream';

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

function started(runId: string): PrReviewEvent {
  return {
    type: 'pr-review-started',
    runId,
    lenses: ['logic'],
    model: 'm',
  } as PrReviewEvent;
}

function lensCompleted(runId: string, findings: ReviewFinding[]): PrReviewEvent {
  return {
    type: 'pr-review-lens-completed',
    runId,
    lens: 'logic',
    findings,
    costUsd: 0,
  } as PrReviewEvent;
}

/** A registry entry built directly (bypassing the fold) for selector tests. */
function entryFor(
  runId: string,
  over: Partial<ReviewStream>,
  startedAt: number,
): [string, PrReviewRunEntry] {
  return [
    runId,
    { stream: { ...EMPTY_REVIEW_STREAM, runId, ...over }, startedAt },
  ];
}

function persistedRun(over: Partial<PrReviewRun> = {}): PrReviewRun {
  return {
    id: 'run-1',
    projectPath: '/proj',
    prNumber: 7,
    status: 'completed',
    lenses: ['logic'],
    model: 'm',
    createdAt: 1000,
    updatedAt: 2000,
    costUsd: 0.5,
    durationMs: 100,
    usage: { inputTokens: 10, outputTokens: 5 },
    findings: [],
    error: null,
    verdict: null,
    verdictReasoning: null,
    headSha: null,
    postedVerdict: null,
    postedAt: null,
    ...over,
  };
}

describe('foldRegistry', () => {
  it('routes concurrent runs independently — each run folds its own stream', () => {
    let reg: PrReviewRunRegistry = EMPTY_RUN_REGISTRY;
    reg = foldRegistry(reg, started('run-a'), 100);
    reg = foldRegistry(reg, started('run-b'), 200);
    reg = foldRegistry(
      reg,
      lensCompleted('run-a', [wireFinding({ id: 'a1', fingerprint: 'a1' })]),
      300,
    );
    reg = foldRegistry(
      reg,
      lensCompleted('run-b', [wireFinding({ id: 'b1', fingerprint: 'b1' })]),
      400,
    );

    expect(reg.size).toBe(2);
    expect(reg.get('run-a')?.stream.findings.map((f) => f.id)).toEqual(['a1']);
    expect(reg.get('run-b')?.stream.findings.map((f) => f.id)).toEqual(['b1']);
    // Later folds preserve the entry's original recency ordinal.
    expect(reg.get('run-a')?.startedAt).toBe(100);
    expect(reg.get('run-b')?.startedAt).toBe(200);
  });

  it('creates an entry for an unknown runId (a run started before mount)', () => {
    const reg = foldRegistry(
      EMPTY_RUN_REGISTRY,
      lensCompleted('run-x', [wireFinding()]),
      50,
    );
    const entry = reg.get('run-x');
    expect(entry).toBeDefined();
    // The seed carries the event's runId (only `pr-review-started` sets it
    // inside the per-run fold) and a running status.
    expect(entry?.stream.runId).toBe('run-x');
    expect(entry?.stream.status).toBe('running');
    expect(entry?.stream.findings).toHaveLength(1);
    expect(entry?.startedAt).toBe(50);
  });

  it('folds a converted-finding acknowledgement into the RIGHT run', () => {
    // Both runs carry a finding with the SAME id — only run-b's may convert.
    let reg: PrReviewRunRegistry = EMPTY_RUN_REGISTRY;
    reg = foldRegistry(reg, lensCompleted('run-a', [wireFinding()]), 1);
    reg = foldRegistry(reg, lensCompleted('run-b', [wireFinding()]), 2);
    reg = foldRegistry(reg, {
      type: 'pr-review-finding-converted',
      runId: 'run-b',
      findingId: 'f1',
      taskId: 'task-9',
    } as PrReviewEvent);

    expect(reg.get('run-b')?.stream.findings[0]?.status).toBe(
      'converted' satisfies FindingStatus,
    );
    expect(reg.get('run-b')?.stream.findings[0]?.linkedTaskId).toBe('task-9');
    expect(reg.get('run-a')?.stream.findings[0]?.status).toBe('open');
    expect(reg.get('run-a')?.stream.findings[0]?.linkedTaskId).toBeNull();
  });

  it('a converted acknowledgement for an unknown run is a no-op', () => {
    const next = foldRegistry(EMPTY_RUN_REGISTRY, {
      type: 'pr-review-finding-converted',
      runId: 'run-ghost',
      findingId: 'f1',
      taskId: 't1',
    } as PrReviewEvent);
    expect(next).toBe(EMPTY_RUN_REGISTRY);
  });
});

describe('reconcileRegistryRun', () => {
  it('replaces the folded stream with the authoritative persisted projection', () => {
    let reg: PrReviewRunRegistry = EMPTY_RUN_REGISTRY;
    reg = foldRegistry(reg, started('run-1'), 999);
    const run = persistedRun({
      id: 'run-1',
      prNumber: 42,
      status: 'completed',
      createdAt: 123,
      findings: [
        {
          id: 's1',
          lens: 'logic',
          severity: 'low',
          file: 'src/b.ts',
          line: null,
          title: 'From the store',
          body: 'b',
          suggestedFix: null,
          fingerprint: 'fp-s1',
          corroboratedBy: null,
          status: 'open',
          linkedTaskId: null,
        },
      ],
    });
    reg = reconcileRegistryRun(reg, run);

    const entry = reg.get('run-1');
    expect(entry?.stream.status).toBe('completed');
    expect(entry?.stream.prNumber).toBe(42);
    expect(entry?.stream.findings.map((f) => f.title)).toEqual([
      'From the store',
    ]);
    // The ordinal becomes the run's createdAt (one epoch-ms axis for both sources).
    expect(entry?.startedAt).toBe(123);
  });

  it('refuses to replace a TERMINAL stream with a stale running projection', () => {
    // A slow mount list resolving after the terminal reconcile must not stick
    // the run at "running" forever (no later event would re-reconcile it).
    const reg: PrReviewRunRegistry = new Map([
      entryFor('run-1', { prNumber: 7, status: 'completed' }, 400),
    ]);
    const stale = persistedRun({ id: 'run-1', prNumber: 7, status: 'running' });
    expect(reconcileRegistryRun(reg, stale)).toBe(reg);

    const failedReg: PrReviewRunRegistry = new Map([
      entryFor('run-2', { prNumber: 7, status: 'failed' }, 400),
    ]);
    const stale2 = persistedRun({ id: 'run-2', prNumber: 7, status: 'running' });
    expect(reconcileRegistryRun(failedReg, stale2)).toBe(failedReg);
  });

  it('a terminal projection still replaces a terminal stream (the store stays authoritative)', () => {
    const reg: PrReviewRunRegistry = new Map([
      entryFor('run-1', { prNumber: 7, status: 'completed' }, 400),
    ]);
    const persisted = persistedRun({ id: 'run-1', prNumber: 7, status: 'failed' });
    const next = reconcileRegistryRun(reg, persisted);
    expect(next.get('run-1')?.stream.status).toBe('failed');
  });

  it('a running stream is still replaced by any projection (the normal reconcile)', () => {
    const reg: PrReviewRunRegistry = new Map([
      entryFor('run-1', { prNumber: 7, status: 'running' }, 400),
    ]);
    const persisted = persistedRun({ id: 'run-1', prNumber: 7, status: 'running' });
    const next = reconcileRegistryRun(reg, persisted);
    expect(next.get('run-1')?.stream.status).toBe('running');
    expect(next.get('run-1')?.startedAt).toBe(1000);
  });
});

describe('selectors', () => {
  it('latestRunForPr: a running run wins even over a NEWER completed run', () => {
    const reg: PrReviewRunRegistry = new Map([
      entryFor('run-old', { prNumber: 7, status: 'running' }, 50),
      entryFor('run-new', { prNumber: 7, status: 'completed' }, 500),
      entryFor('run-other', { prNumber: 8, status: 'running' }, 900),
    ]);
    expect(latestRunForPr(reg, 7)?.runId).toBe('run-old');
  });

  it('latestRunForPr: with no running run the newest by startedAt wins', () => {
    const reg: PrReviewRunRegistry = new Map([
      entryFor('run-a', { prNumber: 7, status: 'completed' }, 100),
      entryFor('run-b', { prNumber: 7, status: 'failed' }, 300),
      entryFor('run-c', { prNumber: 9, status: 'completed' }, 999),
    ]);
    expect(latestRunForPr(reg, 7)?.runId).toBe('run-b');
    expect(latestRunForPr(reg, 123)).toBeNull();
  });

  it('runningPrNumbers: distinct PR numbers with an in-flight run', () => {
    const reg: PrReviewRunRegistry = new Map([
      entryFor('r1', { prNumber: 3, status: 'running' }, 1),
      entryFor('r2', { prNumber: 3, status: 'running' }, 2),
      entryFor('r3', { prNumber: 5, status: 'running' }, 3),
      entryFor('r4', { prNumber: 9, status: 'completed' }, 4),
      // A pre-reconcile live run with no PR number yet is not reportable.
      entryFor('r5', { prNumber: null, status: 'running' }, 5),
    ]);
    expect(runningPrNumbers(reg).sort()).toEqual([3, 5]);
  });

  it('findingCountForPr: OPEN findings of the LATEST completed run only', () => {
    const finding = (id: string, status: FindingStatus) => ({
      id,
      lens: 'logic' as const,
      severity: 'high' as const,
      file: 'src/a.ts',
      line: null,
      title: 't',
      body: 'b',
      suggestedFix: null,
      fingerprint: id,
      corroboratedBy: [],
      status,
      linkedTaskId: null,
    });
    const reg: PrReviewRunRegistry = new Map([
      // Older completed run — superseded, its counts must not leak through.
      entryFor(
        'run-old',
        {
          prNumber: 7,
          status: 'completed',
          findings: [finding('x1', 'open'), finding('x2', 'open')],
        },
        100,
      ),
      // Latest completed run: 1 open + 1 dismissed + 1 converted → count 1.
      entryFor(
        'run-new',
        {
          prNumber: 7,
          status: 'completed',
          findings: [
            finding('y1', 'open'),
            finding('y2', 'dismissed'),
            finding('y3', 'converted'),
          ],
        },
        200,
      ),
      // A newer RUNNING run's provisional findings never count.
      entryFor(
        'run-live',
        { prNumber: 7, status: 'running', findings: [finding('z1', 'open')] },
        300,
      ),
    ]);
    expect(findingCountForPr(reg, 7)).toBe(1);
    expect(findingCountForPr(reg, 999)).toBe(0);
  });

  it('historyForPr filters the persisted list, preserving newest-first order', () => {
    const runs = [
      persistedRun({ id: 'r3', prNumber: 7, createdAt: 300 }),
      persistedRun({ id: 'r2', prNumber: 9, createdAt: 200 }),
      persistedRun({ id: 'r1', prNumber: 7, createdAt: 100 }),
    ];
    expect(historyForPr(runs, 7).map((r) => r.id)).toEqual(['r3', 'r1']);
    expect(historyForPr(runs, 5)).toEqual([]);
  });
});
