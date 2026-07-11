import { describe, expect, it } from 'vitest';

import type { ScorecardRun, StoredReading } from '@/lib/bridge';

import { buildDimensionRows, priorGradesByDimension } from './scorecard-rows';
import { streamFromRun } from './scorecard-stream';

function reading(dimension: string, grade: string): StoredReading {
  return {
    id: `${dimension}-${grade}`,
    dimension,
    grade,
    title: 't',
    summary: 's',
    rationale: null,
    location: null,
    suggestion: null,
    affectedFiles: [],
    tags: [],
    findings: [],
    confidence: null,
    fingerprint: `fp-${dimension}-${grade}`,
    status: 'open',
    linkedTaskId: null,
  };
}

function run(id: string, createdAt: number, readings: StoredReading[]): ScorecardRun {
  return {
    id,
    projectPath: '/p',
    status: 'completed',
    dimensions: readings.map((r) => r.dimension),
    model: 'm',
    createdAt,
    updatedAt: createdAt,
    costUsd: 0,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    readings,
    error: null,
  };
}

describe('priorGradesByDimension', () => {
  it('collects older runs oldest-first, excluding the current and any newer run', () => {
    const runs = [
      run('r1', 10, [reading('security', 'C')]),
      run('r2', 20, [reading('security', 'B')]),
      run('r3', 30, [reading('security', 'A')]),
    ];
    expect(priorGradesByDimension(runs, 'r2').get('security')).toEqual(['C']);
    expect(priorGradesByDimension(runs, 'r3').get('security')).toEqual(['C', 'B']);
  });

  it('treats a run absent from the list (live/optimistic) as the newest', () => {
    const persisted = [run('r1', 10, [reading('security', 'C')])];
    expect(priorGradesByDimension(persisted, 'live').get('security')).toEqual(['C']);
  });
});

describe('buildDimensionRows', () => {
  const runs = [
    run('r1', 10, [reading('security', 'C'), reading('tests', 'B')]),
    run('r2', 20, [reading('security', 'B'), reading('tests', 'B')]),
    run('r3', 30, [reading('security', 'A'), reading('tests', 'D')]),
  ];

  it('marks an improved grade as an "up" trend with the recent-grades trail', () => {
    const rows = buildDimensionRows(streamFromRun(runs[2]!), runs);
    const security = rows.find((r) => r.dimension === 'security');
    expect(security?.trend).toEqual({
      previousGrade: 'B',
      direction: 'up',
      history: ['C', 'B', 'A'],
    });
  });

  it('marks a regressed grade as a "down" trend', () => {
    const rows = buildDimensionRows(streamFromRun(runs[2]!), runs);
    const tests = rows.find((r) => r.dimension === 'tests');
    expect(tests?.trend?.direction).toBe('down');
    expect(tests?.trend?.previousGrade).toBe('B');
  });

  it('marks an unchanged grade as "flat"', () => {
    const rows = buildDimensionRows(streamFromRun(runs[1]!), runs);
    const tests = rows.find((r) => r.dimension === 'tests');
    expect(tests?.trend?.direction).toBe('flat');
  });

  it('renders no trend for a dimension with no prior run', () => {
    const only = [run('r1', 10, [reading('tests', 'C')])];
    const rows = buildDimensionRows(streamFromRun(only[0]!), only);
    expect(rows.find((r) => r.dimension === 'tests')?.trend).toBeNull();
  });
});
