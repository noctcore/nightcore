/// <reference types="bun" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { ScorecardReading } from '@nightcore/contracts';

import { groundReading, parseReading } from './readings.js';

describe('parseReading', () => {
  test('parses a single reading object, forces dimension, assigns id + fingerprint', () => {
    const raw = JSON.stringify({
      grade: 'B',
      title: 'Solid coverage with gaps',
      summary: 'Happy paths covered; error paths thin.',
      rationale: 'Add error-path tests to reach an A.',
      location: { file: './src/app.ts', startLine: 10 },
      suggestion: 'Cover the error paths.',
      affectedFiles: ['./src/app.ts'],
      tags: ['coverage'],
      findings: [{ detail: 'parse() has no failure test', location: 'src/app.ts:12' }],
      confidence: 0.6,
    });
    const { reading, error } = parseReading(raw, 'tests');
    expect(error).toBeUndefined();
    const r = reading as ScorecardReading;
    expect(r.dimension).toBe('tests');
    expect(r.grade).toBe('B');
    expect(r.location?.file).toBe('src/app.ts'); // normalized (leading ./ stripped)
    expect(r.affectedFiles).toEqual(['src/app.ts']);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.location).toEqual({ file: 'src/app.ts', startLine: 12 });
    expect(r.id.startsWith('tests-')).toBe(true);
    expect(r.fingerprint.length).toBeGreaterThan(0);
  });

  test('rejects an off-scale grade as a parse error (never fakes a neutral C)', () => {
    // "great"/"B+"/"PASS"/"N/A" must NOT be silently coerced to 'C' — that fabricates
    // a grade the model never gave. It errors so the pass's corrective retry re-asks.
    for (const bad of ['great', 'B+', 'PASS', 'N/A']) {
      const { reading, error } = parseReading(
        JSON.stringify({ grade: bad, title: 't', summary: 's' }),
        'security',
      );
      expect(reading, `off-scale grade ${bad} must not yield a reading`).toBeUndefined();
      expect(error).toBeDefined();
    }
  });

  test('uppercases a lowercase grade letter', () => {
    const raw = JSON.stringify({ grade: 'a', title: 't', summary: 's' });
    expect(parseReading(raw, 'security').reading?.grade).toBe('A');
  });

  test('tolerates a one-element array wrapper around the object', () => {
    const raw = JSON.stringify([{ grade: 'D', title: 't', summary: 's' }]);
    expect(parseReading(raw, 'performance').reading?.grade).toBe('D');
  });

  test('accepts `description` as a summary alias', () => {
    const raw = JSON.stringify({ grade: 'C', title: 't', description: 'd' });
    expect(parseReading(raw, 'types').reading?.summary).toBe('d');
  });

  test('reports an error when no JSON object is present', () => {
    const { reading, error } = parseReading('the code looks fine', 'docs-ci');
    expect(reading).toBeUndefined();
    expect(error).toBeDefined();
  });

  test('reports an error when title/summary are missing', () => {
    const { error } = parseReading(JSON.stringify({ grade: 'A' }), 'a11y');
    expect(error).toBeDefined();
  });
});

describe('groundReading', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-ground-'));
    fs.writeFileSync(path.join(dir, 'real.ts'), 'a\nb\nc\n');
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function reading(over: Partial<ScorecardReading>): ScorecardReading {
    return {
      id: 'security-x',
      dimension: 'security',
      grade: 'C',
      title: 't',
      summary: 's',
      affectedFiles: [],
      tags: [],
      findings: [],
      fingerprint: 'fp',
      ...over,
    };
  }

  test('keeps a reading but strips a hallucinated primary location', () => {
    const r = groundReading(
      reading({ location: { file: 'ghost.ts', startLine: 3 } }),
      dir,
    );
    expect(r.location).toBeUndefined();
    expect(r.grade).toBe('C'); // reading itself survives
  });

  test('clamps an out-of-range line on a real file', () => {
    const r = groundReading(
      reading({ location: { file: 'real.ts', startLine: 999 } }),
      dir,
    );
    expect(r.location?.file).toBe('real.ts');
    expect(r.location?.startLine).toBe(4); // clamped to the file length
  });

  test('filters affectedFiles + strips evidence locations that do not exist', () => {
    const r = groundReading(
      reading({
        affectedFiles: ['real.ts', 'ghost.ts'],
        findings: [
          { detail: 'ok', location: { file: 'real.ts', startLine: 1 } },
          { detail: 'bad', location: { file: 'ghost.ts', startLine: 1 } },
        ],
      }),
      dir,
    );
    expect(r.affectedFiles).toEqual(['real.ts']);
    expect(r.findings[0]?.location?.file).toBe('real.ts');
    expect(r.findings[1]?.location).toBeUndefined(); // evidence kept, location stripped
    expect(r.findings).toHaveLength(2);
  });
});
