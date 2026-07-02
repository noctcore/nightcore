/// <reference types="bun" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { ConventionFinding } from '@nightcore/contracts';

import {
  conventionFingerprint,
  dedupeConventionFindings,
  groundConventionFindings,
  parseConventionFindings,
} from './findings.js';

describe('parseConventionFindings', () => {
  test('coerces a JSON array, forces category, assigns id + fingerprint', () => {
    const raw = JSON.stringify([
      {
        kind: 'convention',
        severity: 'high',
        title: 'Folder-per-component',
        description: 'each component in its own folder',
        evidence: [{ file: './apps/web/src/Button/index.tsx', startLine: 1 }],
      },
    ]);
    const { findings, error } = parseConventionFindings(raw, 'folder-structure');
    expect(error).toBeUndefined();
    expect(findings).toHaveLength(1);
    const f = findings[0] as ConventionFinding;
    expect(f.category).toBe('folder-structure');
    expect(f.kind).toBe('convention');
    expect(f.severity).toBe('high');
    expect(f.evidence[0]?.file).toBe('apps/web/src/Button/index.tsx'); // normalized
    expect(f.id.startsWith('folder-structure-')).toBe(true);
    expect(f.fingerprint.length).toBeGreaterThan(0);
  });

  test('accepts an object with a findings array', () => {
    const raw = JSON.stringify({
      findings: [{ title: 't', description: 'd' }],
    });
    const { findings } = parseConventionFindings(raw, 'naming');
    expect(findings).toHaveLength(1);
  });

  test('parses a ```json fenced block with surrounding prose', () => {
    const raw =
      'Here is what I found:\n```json\n[{"title":"x","description":"d"}]\n```\nDone.';
    const { findings, error } = parseConventionFindings(raw, 'architecture');
    expect(error).toBeUndefined();
    expect(findings).toHaveLength(1);
  });

  test('reports an error when the output is prose with no JSON', () => {
    const { findings, error } = parseConventionFindings(
      'the repo looks clean',
      'testing',
    );
    expect(findings).toHaveLength(0);
    expect(error).toBeDefined();
  });

  test('defaults kind to gap and maps synonym severities', () => {
    const raw = JSON.stringify([
      { severity: 'warning', title: 'a', description: 'd' },
      { kind: 'CONVENTION', severity: 'major', title: 'b', description: 'd' },
    ]);
    const { findings } = parseConventionFindings(raw, 'imports-boundaries');
    expect(findings[0]?.kind).toBe('gap'); // no kind → gap
    expect(findings[0]?.severity).toBe('low'); // warning → low
    expect(findings[1]?.kind).toBe('convention'); // case-insensitive
    expect(findings[1]?.severity).toBe('high'); // major → high
  });

  test('accepts a single inline location/file as evidence', () => {
    const raw = JSON.stringify([
      { title: 't', description: 'd', location: 'src/x.ts:5-9' },
      { title: 'u', description: 'd', file: 'src/y.ts' },
    ]);
    const { findings } = parseConventionFindings(raw, 'naming');
    expect(findings[0]?.evidence).toEqual([
      { file: 'src/x.ts', startLine: 5, endLine: 9 },
    ]);
    expect(findings[1]?.evidence[0]?.file).toBe('src/y.ts');
  });

  test('keeps a fileless convention (no evidence) as valid', () => {
    const raw = JSON.stringify([
      { kind: 'convention', title: 'Monorepo uses bun workspaces', description: 'd' },
    ]);
    const { findings } = parseConventionFindings(raw, 'tooling-lint');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toEqual([]);
  });

  test('skips items missing title/description but keeps valid ones', () => {
    const raw = JSON.stringify([
      { severity: 'low', title: 'no description' },
      { title: 'ok', description: 'present' },
    ]);
    const { findings } = parseConventionFindings(raw, 'agent-context');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe('ok');
  });
});

describe('conventionFingerprint', () => {
  test('is stable across whitespace/case differences in the title', () => {
    const a = conventionFingerprint('naming', 'Use  kebab-Case Files');
    const b = conventionFingerprint('naming', 'use kebab-case files');
    expect(a).toBe(b);
  });

  test('is category-SCOPED (same title, different category → different fp)', () => {
    expect(conventionFingerprint('naming', 'x')).not.toBe(
      conventionFingerprint('architecture', 'x'),
    );
  });
});

describe('groundConventionFindings', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-h-ground-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'real.ts'), 'a\nb\nc\nd\ne\n'); // 6 lines
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function finding(over: Partial<ConventionFinding>): ConventionFinding {
    return {
      id: 'id',
      category: 'architecture',
      kind: 'gap',
      severity: 'medium',
      title: 't',
      description: 'd',
      evidence: [],
      tags: [],
      fingerprint: 'fp',
      ...over,
    };
  }

  test('KEEPS a fileless finding (unlike Insight) with empty evidence', () => {
    const out = groundConventionFindings([finding({ evidence: [] })], dir);
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence).toEqual([]);
  });

  test('keeps the finding but drops hallucinated evidence files', () => {
    const out = groundConventionFindings(
      [
        finding({
          evidence: [
            { file: 'src/real.ts', startLine: 2 },
            { file: 'src/ghost.ts', startLine: 1 },
          ],
        }),
      ],
      dir,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence.map((e) => e.file)).toEqual(['src/real.ts']);
  });

  test('clamps overlong line numbers to the real file length', () => {
    const out = groundConventionFindings(
      [finding({ evidence: [{ file: 'src/real.ts', startLine: 999, endLine: 1000 }] })],
      dir,
    );
    expect(out[0]?.evidence[0]?.startLine).toBeLessThanOrEqual(6);
    expect(out[0]?.evidence[0]?.endLine).toBeLessThanOrEqual(6);
  });

  test('rejects path-traversal evidence but keeps the finding', () => {
    const out = groundConventionFindings(
      [finding({ evidence: [{ file: '../../etc/passwd' }] })],
      dir,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence).toEqual([]);
  });
});

describe('dedupeConventionFindings', () => {
  function finding(over: Partial<ConventionFinding>): ConventionFinding {
    return {
      id: 'id',
      category: 'naming',
      kind: 'convention',
      severity: 'medium',
      title: 't',
      description: 'd',
      evidence: [],
      tags: [],
      fingerprint: 'fp',
      ...over,
    };
  }

  test('merges same fingerprint, keeping higher severity + unioning tags', () => {
    const out = dedupeConventionFindings([
      finding({ severity: 'low', fingerprint: 'shared', tags: ['a'] }),
      finding({ severity: 'high', fingerprint: 'shared', tags: ['b'] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe('high');
    expect(out[0]?.tags.sort()).toEqual(['a', 'b']);
  });

  test('does not merge distinct fingerprints', () => {
    const out = dedupeConventionFindings([
      finding({ fingerprint: 'fp-a' }),
      finding({ fingerprint: 'fp-b' }),
    ]);
    expect(out).toHaveLength(2);
  });
});
