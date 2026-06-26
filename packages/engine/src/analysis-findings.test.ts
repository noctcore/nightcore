/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  dedupeFindings,
  extractJson,
  fingerprintOf,
  groundFindings,
  parseFindings,
  severityRank,
} from './analysis-findings.js';
import type { Finding } from '@nightcore/contracts';

describe('extractJson', () => {
  test('parses a bare JSON array', () => {
    expect(extractJson('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  test('parses a ```json fenced block with surrounding prose', () => {
    const raw =
      'Here are the findings:\n```json\n[{"title":"x"}]\n```\nDone.';
    expect(extractJson(raw)).toEqual([{ title: 'x' }]);
  });

  test('extracts a balanced array from mixed prose', () => {
    const raw = 'blah blah [ {"title":"y"} ] trailing';
    expect(extractJson(raw)).toEqual([{ title: 'y' }]);
  });

  test('returns undefined when no JSON is present', () => {
    expect(extractJson('no json here at all')).toBeUndefined();
  });
});

describe('parseFindings', () => {
  test('coerces raw items, forces category, assigns id + fingerprint', () => {
    const raw = JSON.stringify([
      {
        severity: 'high',
        effort: 'small',
        title: 'Unawaited promise',
        description: 'drops errors',
        location: { file: './src/a.ts', startLine: 10 },
      },
    ]);
    const { findings, error } = parseFindings(raw, 'bugs');
    expect(error).toBeUndefined();
    expect(findings).toHaveLength(1);
    const f = findings[0] as Finding;
    expect(f.category).toBe('bugs');
    expect(f.severity).toBe('high');
    expect(f.location?.file).toBe('src/a.ts'); // normalized (leading ./ stripped)
    expect(f.id.startsWith('bugs-')).toBe(true);
    expect(f.fingerprint.length).toBeGreaterThan(0);
  });

  test('accepts an object with a findings array', () => {
    const raw = JSON.stringify({ findings: [{ title: 't', description: 'd' }] });
    const { findings } = parseFindings(raw, 'refactor');
    expect(findings).toHaveLength(1);
  });

  test('maps synonym severities/efforts onto the unified scale', () => {
    const raw = JSON.stringify([
      { severity: 'warning', effort: 'easy', title: 'a', description: 'd' },
      { severity: 'major', effort: 'complex', title: 'b', description: 'd' },
    ]);
    const { findings } = parseFindings(raw, 'performance');
    expect(findings[0]?.severity).toBe('low');
    expect(findings[0]?.effort).toBe('small');
    expect(findings[1]?.severity).toBe('high');
    expect(findings[1]?.effort).toBe('large');
  });

  test('skips items missing title/description but keeps valid ones', () => {
    const raw = JSON.stringify([
      { severity: 'low', title: 'no description' },
      { title: 'ok', description: 'present' },
    ]);
    const { findings } = parseFindings(raw, 'docs');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe('ok');
  });

  test('parses a "file:line-line" location string', () => {
    const raw = JSON.stringify([
      { title: 't', description: 'd', location: 'src/x.ts:5-9' },
    ]);
    const { findings } = parseFindings(raw, 'security');
    expect(findings[0]?.location).toEqual({
      file: 'src/x.ts',
      startLine: 5,
      endLine: 9,
    });
  });

  test('reports an error when no JSON array is present', () => {
    const { findings, error } = parseFindings('the code looks fine', 'tests');
    expect(findings).toHaveLength(0);
    expect(error).toBeDefined();
  });
});

describe('fingerprintOf', () => {
  test('is stable across whitespace/case differences in the title', () => {
    const a = fingerprintOf('src/a.ts', 'Unawaited  Promise');
    const b = fingerprintOf('src/a.ts', 'unawaited promise');
    expect(a).toBe(b);
  });

  test('is category-independent (same file+title → same fingerprint)', () => {
    // The same issue surfaced by two passes must share a fingerprint so the
    // dismissed-history match survives the cross-category dedup's category choice.
    const a = fingerprintOf('src/a.ts', 'x');
    const b = fingerprintOf('src/a.ts', 'x');
    expect(a).toBe(b);
  });

  test('differs by file', () => {
    expect(fingerprintOf('src/a.ts', 'x')).not.toBe(
      fingerprintOf('src/b.ts', 'x'),
    );
  });
});

describe('groundFindings', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ground-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'real.ts'), 'a\nb\nc\nd\ne\n'); // 6 lines
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function finding(over: Partial<Finding>): Finding {
    return {
      id: 'id',
      category: 'bugs',
      severity: 'medium',
      effort: 'small',
      title: 't',
      description: 'd',
      affectedFiles: [],
      tags: [],
      fingerprint: 'fp',
      ...over,
    };
  }

  test('drops a finding whose location.file does not exist', () => {
    const out = groundFindings(
      [finding({ location: { file: 'src/ghost.ts', startLine: 1 } })],
      dir,
    );
    expect(out).toHaveLength(0);
  });

  test('keeps a finding with a real file and clamps overlong line numbers', () => {
    const out = groundFindings(
      [finding({ location: { file: 'src/real.ts', startLine: 999, endLine: 1000 } })],
      dir,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.location?.startLine).toBeLessThanOrEqual(6);
    expect(out[0]?.location?.endLine).toBeLessThanOrEqual(6);
  });

  test('keeps a fileless (repo-level) finding and filters bad affectedFiles', () => {
    const out = groundFindings(
      [finding({ affectedFiles: ['src/real.ts', 'src/ghost.ts'] })],
      dir,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.affectedFiles).toEqual(['src/real.ts']);
  });

  test('rejects path-traversal file refs', () => {
    const out = groundFindings(
      [finding({ location: { file: '../../etc/passwd' } })],
      dir,
    );
    expect(out).toHaveLength(0);
  });
});

describe('dedupeFindings', () => {
  function finding(over: Partial<Finding>): Finding {
    return {
      id: 'id',
      category: 'bugs',
      severity: 'medium',
      effort: 'small',
      title: 't',
      description: 'd',
      affectedFiles: [],
      tags: [],
      fingerprint: 'fp',
      ...over,
    };
  }

  test('merges same fingerprint across categories, keeping higher severity', () => {
    const out = dedupeFindings([
      finding({
        category: 'performance',
        severity: 'low',
        title: 'Slow loop',
        fingerprint: 'shared',
        tags: ['perf'],
      }),
      finding({
        category: 'refactor',
        severity: 'high',
        title: 'slow loop',
        fingerprint: 'shared',
        tags: ['smell'],
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe('high');
    expect(out[0]?.tags.sort()).toEqual(['perf', 'smell']);
  });

  test('does not merge distinct fingerprints', () => {
    const out = dedupeFindings([
      finding({ title: 'a', fingerprint: 'fp-a' }),
      finding({ title: 'b', fingerprint: 'fp-b' }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('severityRank', () => {
  test('orders low → high', () => {
    expect(severityRank('info')).toBeLessThan(severityRank('low'));
    expect(severityRank('high')).toBeLessThan(severityRank('critical'));
  });
});
