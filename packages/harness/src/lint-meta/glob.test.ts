import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { isBunRuntime, portableGlob, walkGlob } from './glob.js';

let root: string;

const FILES = [
  '.env',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yaml',
  '.github/actions/setup/action.yml',
  '.a/.b/deep.yml',
  'Dockerfile',
  'src/a.ts',
  'src/B.TS',
  'src/sub/b.ts',
  'src/.hidden/h.ts',
  'node_modules/pkg/i.ts',
];

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'nc-harness-glob-'));
  for (const rel of FILES) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), 'x');
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Patterns lint-meta rules use, plus the edges of Node's semantics. Every one is
 * compared against REAL Node `fs.globSync` in a `node` subprocess.
 */
const CORPUS = [
  '.github/workflows/*.yml',
  '.github/workflows/*.yaml',
  '.github/workflows/*.{yml,yaml}',
  '.github/workflows/ci.yml',
  '.github/**/*.yml',
  '.github/**',
  '.a/.b/*.yml',
  '.*',
  '.env',
  '*',
  '*/',
  '**',
  '**/*',
  '**/*.yml',
  '**/*.ts',
  '**/b.ts',
  '**/Dockerfile',
  'src/**',
  'src/**/*.ts',
  'src/*/',
  'src/.hidden/*.ts',
  'src/**/.hidden/*.ts',
  'src/?.ts',
  'src/[!a].ts',
  'src/*.[tT][sS]',
  'src/*.TS',
  'SRC/*.ts',
  './src/*.ts',
  'src/../src/a.ts',
  '{src,.github}/**/*.{ts,yml}',
  'nope/*.ts',
  'src/a.ts/',
];

/** Real Node `fs.globSync`, run under `node` whatever runtime runs this test. */
function nodeGlobSync(patterns: readonly string[]): Record<string, string[]> {
  const script = `
    const { globSync } = require('node:fs');
    const [cwd, patterns] = JSON.parse(process.argv[1]);
    const out = {};
    for (const p of patterns) out[p] = globSync(p, { cwd }).map((r) => r.replace(/\\\\/g, '/')).sort();
    process.stdout.write(JSON.stringify(out));`;
  const res = spawnSync('node', ['-e', script, JSON.stringify([root, patterns])], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`node globSync failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as Record<string, string[]>;
}

describe('portableGlob: parity with Node fs.globSync', () => {
  test('this suite runs under Bun, so the walker path is what is tested', () => {
    expect(isBunRuntime()).toBe(true);
  });

  test('every corpus pattern matches exactly what Node returns', () => {
    const reference = nodeGlobSync(CORPUS);
    const mismatches = CORPUS.filter(
      (pattern) => JSON.stringify(portableGlob(pattern, root)) !== JSON.stringify(reference[pattern]),
    ).map((pattern) => ({ pattern, ours: portableGlob(pattern, root), node: reference[pattern] }));
    expect(mismatches).toEqual([]);
    // Not vacuous: the dot-directory patterns found real files.
    expect(reference['.github/workflows/*.yml']).toEqual(['.github/workflows/ci.yml']);
  });
});

describe('walkGlob: semantics', () => {
  test('a dot-directory is reachable only through a pattern that names it', () => {
    expect(walkGlob('.github/workflows/*.yml', root)).toEqual(['.github/workflows/ci.yml']);
    expect(walkGlob('**/*.yml', root)).toEqual([]);
    expect(walkGlob('.github/**/*.yml', root).sort()).toEqual([
      '.github/actions/setup/action.yml',
      '.github/workflows/ci.yml',
    ]);
  });

  test('** does not enter a symlinked directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nc-harness-glob-link-'));
    try {
      mkdirSync(path.join(dir, 'real'));
      writeFileSync(path.join(dir, 'real', 'x.ts'), 'x');
      symlinkSync('real', path.join(dir, 'link'));
      expect(walkGlob('**/*.ts', dir)).toEqual(['real/x.ts']);
      // A pattern that names the link still resolves through it, as in Node.
      expect(walkGlob('link/*.ts', dir)).toEqual(['link/x.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('syntax the walker does not implement throws instead of matching nothing', () => {
    expect(() => walkGlob('src/+(a|b).ts', root)).toThrow(/extglob is not supported under Bun/);
    expect(() => walkGlob('src/!(a).ts', root)).toThrow(/extglob/);
    expect(() => walkGlob('src/[[:alpha:]].ts', root)).toThrow(/POSIX character class/);
    expect(() => walkGlob('file{1..3}.ts', root)).toThrow(/brace range/);
  });
});
