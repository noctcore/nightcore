import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Glob } from 'bun';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createNodeCtx, normalizeText, toPosixRel } from './ctx.js';
import type { IMetaCtx } from './types.js';

describe('normalizeText / toPosixRel', () => {
  test('CRLF and lone CR collapse to LF', () => {
    expect(normalizeText('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });
  test('backslashes become forward slashes', () => {
    expect(toPosixRel('src\\nested\\c.ts')).toBe('src/nested/c.ts');
  });
});

describe('createNodeCtx — real filesystem', () => {
  let root: string;
  let ctx: IMetaCtx;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'nc-harness-ctx-'));
    mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
    writeFileSync(path.join(root, 'a.ts'), 'root file\r\nwith crlf\r\n');
    writeFileSync(path.join(root, 'src', 'b.ts'), 'b');
    writeFileSync(path.join(root, 'src', 'nested', 'c.ts'), 'c');
    writeFileSync(path.join(root, 'src', 'd.js'), 'd');
    writeFileSync(path.join(root, 'README.md'), '# readme');
    ctx = createNodeCtx(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('read returns LF-normalized content; a missing file is null', () => {
    expect(ctx.read('a.ts')).toBe('root file\nwith crlf\n');
    expect(ctx.read('does/not/exist.ts')).toBeNull();
  });

  test('exists reflects the filesystem', () => {
    expect(ctx.exists('src/b.ts')).toBe(true);
    expect(ctx.exists('src/missing.ts')).toBe(false);
  });

  test('root is the absolute target directory', () => {
    expect(ctx.root).toBe(root);
  });

  // The load-bearing trap-b assertion: fs.globSync must return the SAME set as
  // the Bun Glob the internal engine used, so a ported rule matches the same files.
  test('glob (fs.globSync) matches a Bun Glob ctx exactly', () => {
    const bunGlob = (pattern: string): string[] =>
      Array.from(new Glob(pattern).scanSync({ cwd: root })).map(toPosixRel);
    for (const pattern of ['**/*.ts', 'src/**/*.ts', '**/*.js', '**/*.md']) {
      const node = [...ctx.glob(pattern)].sort();
      const bun = bunGlob(pattern).sort();
      expect(node).toEqual(bun);
    }
    // sanity: the ts glob really found the nested files (not vacuously equal)
    expect([...ctx.glob('**/*.ts')].sort()).toEqual(['a.ts', 'src/b.ts', 'src/nested/c.ts']);
  });

  test('exec runs a command and captures output; it never throws', () => {
    const ok = ctx.exec('node -e "process.stdout.write(String(1+1))"');
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('2');

    const fail = ctx.exec('node -e "process.exit(3)"');
    expect(fail.code).toBe(3);

    // A command that cannot launch returns a non-zero code rather than throwing.
    const missing = ctx.exec('this-program-does-not-exist-xyz');
    expect(missing.code).not.toBe(0);
  });
});
