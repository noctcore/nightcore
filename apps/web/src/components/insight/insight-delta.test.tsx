import { describe, expect, it } from 'vitest';

import type { InsightRun, StoredFinding } from '@/lib/bridge';

import { comparabilityBasis, computeInsightRunDelta } from './insight-delta';

function finding(fingerprint: string, over: Partial<StoredFinding> = {}): StoredFinding {
  return {
    id: `bugs-${fingerprint}`,
    category: 'bugs',
    severity: 'high',
    effort: 'small',
    title: 'Unawaited promise',
    description: 'drops errors',
    rationale: null,
    location: null,
    suggestion: null,
    codeBefore: null,
    codeAfter: null,
    affectedFiles: [],
    tags: [],
    confidence: null,
    fingerprint,
    status: 'open',
    linkedTaskId: null,
    ...over,
  };
}

/** A completed, standard-depth, repo-scope run that spent money — the diffable
 *  baseline every case below perturbs one field of. */
function run(id: string, over: Partial<InsightRun> = {}): InsightRun {
  return {
    id,
    projectPath: '/proj',
    scope: 'repo',
    status: 'completed',
    categories: ['bugs', 'security'],
    model: 'claude-opus-4-8',
    createdAt: 1_000,
    updatedAt: 1_000,
    costUsd: 0.5,
    durationMs: 1_000,
    usage: { inputTokens: 100, outputTokens: 50 },
    findings: [],
    roundsByCategory: {},
    deep: false,
    error: null,
    ...over,
  };
}

describe('comparabilityBasis', () => {
  it('matches two runs with the same project/scope/depth/categories', () => {
    expect(comparabilityBasis(run('a'))).toBe(
      comparabilityBasis(run('b', { model: 'other-model' })),
    );
  });

  it('ignores category ORDER and duplicates (coverage is a set)', () => {
    expect(comparabilityBasis(run('a', { categories: ['security', 'bugs', 'bugs'] }))).toBe(
      comparabilityBasis(run('b', { categories: ['bugs', 'security'] })),
    );
  });

  it('separates a deep run from a standard one', () => {
    expect(comparabilityBasis(run('a', { deep: true }))).not.toBe(
      comparabilityBasis(run('b', { deep: false })),
    );
  });

  it('separates different category sets', () => {
    expect(comparabilityBasis(run('a', { categories: ['bugs'] }))).not.toBe(
      comparabilityBasis(run('b', { categories: ['bugs', 'security'] })),
    );
  });

  it('refuses a run that did not complete', () => {
    expect(comparabilityBasis(run('a', { status: 'running' }))).toBeNull();
    expect(comparabilityBasis(run('a', { status: 'failed' }))).toBeNull();
  });

  it('refuses diff scope (its changed-file coverage is not persisted)', () => {
    expect(comparabilityBasis(run('a', { scope: 'diff' }))).toBeNull();
  });

  it('refuses a run of unknown depth (persisted before the field existed)', () => {
    expect(comparabilityBasis(run('a', { deep: null }))).toBeNull();
  });

  it('refuses a $0 / no-token run (the usage-limit signature, not a real sweep)', () => {
    expect(
      comparabilityBasis(
        run('a', { costUsd: 0, usage: { inputTokens: 0, outputTokens: 0 } }),
      ),
    ).toBeNull();
  });
});

describe('computeInsightRunDelta', () => {
  it('counts apparent new / resolved / persisting against the previous comparable run', () => {
    const previous = run('r1', {
      createdAt: 1_000,
      findings: [finding('a'), finding('b'), finding('c')],
    });
    const current = run('r2', {
      createdAt: 2_000,
      findings: [finding('b'), finding('c'), finding('d'), finding('e')],
    });
    const result = computeInsightRunDelta([current, previous], 'r2');
    expect(result.kind).toBe('delta');
    if (result.kind !== 'delta') return;
    expect(result.delta).toMatchObject({
      apparentNew: 2,
      apparentResolved: 1,
      persisting: 2,
      previousRunId: 'r1',
      previousRunCreatedAt: 1_000,
      modelChanged: false,
    });
  });

  it('counts a finding regardless of the user lifecycle mark on it', () => {
    // Dismissing or converting a finding annotates it — it does not unfind it, so
    // coverage counts all three statuses. A run whose only finding was dismissed
    // still reports it as persisting on the next run.
    const previous = run('r1', {
      createdAt: 1_000,
      findings: [finding('a', { status: 'dismissed' })],
    });
    const current = run('r2', {
      createdAt: 2_000,
      findings: [finding('a', { status: 'converted', linkedTaskId: 't1' })],
    });
    const result = computeInsightRunDelta([current, previous], 'r2');
    expect(result.kind === 'delta' && result.delta.persisting).toBe(1);
  });

  it('picks the NEWEST comparable predecessor, skipping incomparable ones', () => {
    const oldest = run('r1', { createdAt: 1_000, findings: [finding('a')] });
    const deeper = run('r2', { createdAt: 2_000, deep: true, findings: [finding('z')] });
    const current = run('r3', { createdAt: 3_000, findings: [finding('a')] });
    const result = computeInsightRunDelta([current, deeper, oldest], 'r3');
    expect(result.kind === 'delta' && result.delta.previousRunId).toBe('r1');
  });

  it('never compares against a LATER run', () => {
    const later = run('r2', { createdAt: 5_000, findings: [finding('a')] });
    const current = run('r1', { createdAt: 1_000, findings: [finding('b')] });
    expect(computeInsightRunDelta([later, current], 'r1')).toEqual({
      kind: 'unavailable',
      blocker: 'no-earlier-run',
    });
  });

  it('discloses a model change without blocking the comparison', () => {
    const previous = run('r1', { createdAt: 1_000, model: 'claude-sonnet-4-6' });
    const current = run('r2', { createdAt: 2_000, model: 'claude-opus-4-8' });
    const result = computeInsightRunDelta([current, previous], 'r2');
    expect(result.kind === 'delta' && result.delta.modelChanged).toBe(true);
    expect(result.kind === 'delta' && result.delta.previousRunModel).toBe(
      'claude-sonnet-4-6',
    );
  });

  it('reports no-earlier-run for the first run of a project', () => {
    expect(computeInsightRunDelta([run('r1')], 'r1')).toEqual({
      kind: 'unavailable',
      blocker: 'no-earlier-run',
    });
  });

  it('reports run-not-diffable when the displayed run itself cannot anchor a diff', () => {
    const previous = run('r1', { createdAt: 1_000 });
    const current = run('r2', { createdAt: 2_000, scope: 'diff' });
    expect(computeInsightRunDelta([current, previous], 'r2')).toEqual({
      kind: 'unavailable',
      blocker: 'run-not-diffable',
    });
  });

  it('reports run-not-diffable for an unknown / not-yet-persisted run id', () => {
    expect(computeInsightRunDelta([run('r1')], 'ghost')).toEqual({
      kind: 'unavailable',
      blocker: 'run-not-diffable',
    });
    expect(computeInsightRunDelta([], null)).toEqual({
      kind: 'unavailable',
      blocker: 'run-not-diffable',
    });
  });

  it('reports no-comparable-run when every earlier run swept different ground', () => {
    const shallowOther = run('r1', { createdAt: 1_000, categories: ['bugs'] });
    const current = run('r2', { createdAt: 2_000 });
    expect(computeInsightRunDelta([current, shallowOther], 'r2')).toEqual({
      kind: 'unavailable',
      blocker: 'no-comparable-run',
    });
  });

  it('is deterministic when two runs share a timestamp', () => {
    const a = run('r-a', { createdAt: 1_000, findings: [finding('a')] });
    const b = run('r-b', { createdAt: 1_000, findings: [finding('b')] });
    // `r-b` sorts after `r-a`, so `r-a` is its predecessor and `r-a` has none.
    expect(computeInsightRunDelta([a, b], 'r-b')).toMatchObject({
      kind: 'delta',
      delta: { previousRunId: 'r-a', apparentNew: 1, apparentResolved: 1, persisting: 0 },
    });
    expect(computeInsightRunDelta([a, b], 'r-a')).toEqual({
      kind: 'unavailable',
      blocker: 'no-earlier-run',
    });
  });
});
