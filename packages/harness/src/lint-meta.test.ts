import path from 'node:path';
import { describe, expect, test } from 'bun:test';

import { type CliIO, runCli } from './cli.js';
import type { ModuleImporter } from './lint-meta/registry.js';
import type { IMetaRule } from './lint-meta/types.js';
import type { SpawnResult } from './run.js';

const passRule: IMetaRule = { id: 'pass', category: 'source-text', description: 'ok', run: () => [] };
const failRule: IMetaRule = {
  id: 'no-todo',
  category: 'source-text',
  description: 'no TODO',
  ciCritical: true,
  run: () => [{ file: 'src/x.ts', rule: 'no-todo', message: 'found a TODO' }],
};

interface Harness {
  io: CliIO;
  out: string[];
  err: string[];
  imported: string[];
  readPaths: string[];
}

/**
 * A fake CliIO for the lint-meta path. `present` is the set of registry paths
 * `read` reports as existing; `mod` is what the injected importer resolves to.
 */
function harness(opts: { present?: string[]; mod?: unknown; importThrows?: unknown } = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const imported: string[] = [];
  const readPaths: string[] = [];
  const present = new Set(opts.present ?? []);

  const importer: ModuleImporter = (p) => {
    imported.push(p);
    if (opts.importThrows !== undefined) return Promise.reject(opts.importThrows);
    return Promise.resolve(opts.mod);
  };

  const io: CliIO = {
    cwd: '/repo',
    read: (p) => {
      readPaths.push(p);
      return present.has(p) ? '// registry' : null;
    },
    spawn: (): SpawnResult => ({ status: 0, signal: null, stdout: '', stderr: '' }),
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    importModule: importer,
  };
  return { io, out, err, imported, readPaths };
}

const DEFAULT_REGISTRY = path.join('/repo', '.nightcore', 'lint-meta', 'registry.js');

describe('runCli lint-meta — opt-in-by-presence', () => {
  test('an absent registry exits 0 with a friendly note (nothing imported)', async () => {
    const h = harness();
    expect(await runCli(['lint-meta'], h.io)).toBe(0);
    expect(h.out.join('\n')).toContain('nothing to enforce');
    expect(h.imported).toEqual([]);
  });

  test('the default registry path is <dir>/.nightcore/lint-meta/registry.js', async () => {
    const h = harness();
    await runCli(['lint-meta'], h.io);
    expect(h.readPaths[0]).toBe(DEFAULT_REGISTRY);
  });
});

describe('runCli lint-meta — verdicts', () => {
  test('a passing registry exits 0 and echoes each rule (legibility)', async () => {
    const h = harness({ present: [DEFAULT_REGISTRY], mod: { META_RULES: [passRule] } });
    expect(await runCli(['lint-meta'], h.io)).toBe(0);
    const stdout = h.out.join('\n');
    expect(stdout).toContain('running 1 rule');
    expect(stdout).toContain('→ pass');
    expect(stdout).toContain('no violations');
  });

  test('a ciCritical violation exits 1 with the [ERROR] line on stderr', async () => {
    const h = harness({ present: [DEFAULT_REGISTRY], mod: { META_RULES: [failRule] } });
    expect(await runCli(['lint-meta'], h.io)).toBe(1);
    expect(h.err.join('\n')).toBe('[ERROR] no-todo (src/x.ts): found a TODO');
  });

  test('a registry that fails to import reds the build (exit 1)', async () => {
    const h = harness({ present: [DEFAULT_REGISTRY], importThrows: new Error('boom') });
    expect(await runCli(['lint-meta'], h.io)).toBe(1);
    expect(h.err.join('\n')).toContain('Failed to load the lint-meta registry');
    expect(h.err.join('\n')).toContain('boom');
  });

  test('a registry with no META_RULES reds the build (exit 1)', async () => {
    const h = harness({ present: [DEFAULT_REGISTRY], mod: { nope: 1 } });
    expect(await runCli(['lint-meta'], h.io)).toBe(1);
    expect(h.err.join('\n')).toContain('META_RULES');
  });
});

describe('runCli lint-meta — path resolution + bounded eval', () => {
  test('--dir relocates the default registry lookup', async () => {
    const h = harness();
    await runCli(['lint-meta', '--dir', '/some/where'], h.io);
    expect(h.readPaths[0]).toBe(path.join('/some/where', '.nightcore', 'lint-meta', 'registry.js'));
  });

  test('--registry (relative to --dir) overrides the default path', async () => {
    const custom = path.resolve('/repo', 'config/rules.js');
    const h = harness({ present: [custom], mod: { META_RULES: [passRule] } });
    expect(await runCli(['lint-meta', '--registry', 'config/rules.js'], h.io)).toBe(0);
    // Both the presence read AND the (single) import target the resolved path — nothing else.
    expect(h.readPaths).toContain(custom);
    expect(h.imported).toEqual([custom]);
  });

  test('bounded eval: only the enumerated registry is ever imported', async () => {
    const h = harness({ present: [DEFAULT_REGISTRY], mod: { META_RULES: [passRule] } });
    await runCli(['lint-meta'], h.io);
    expect(h.imported).toEqual([DEFAULT_REGISTRY]);
  });
});
