import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_REGISTRY_RELATIVE_PATHS,
  loadRegistry,
  type ModuleImporter,
} from './registry.js';
import type { IMetaRule } from './types.js';

const aRule: IMetaRule = {
  id: 'a',
  category: 'source-text',
  description: 'a',
  run: () => [],
};

/** An importer that records every path it is asked to import. */
function recordingImporter(mod: unknown): { importer: ModuleImporter; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    importer: (absPath) => {
      calls.push(absPath);
      return Promise.resolve(mod);
    },
  };
}

describe('loadRegistry — accepted export shapes', () => {
  test('a named META_RULES export (ESM shape)', async () => {
    const { importer } = recordingImporter({ META_RULES: [aRule] });
    const loaded = await loadRegistry('/repo/registry.js', importer);
    expect(loaded.error).toBeUndefined();
    expect(loaded.rules).toEqual([aRule]);
  });

  test('a default whose value is { META_RULES } (CJS interop shape)', async () => {
    const { importer } = recordingImporter({ default: { META_RULES: [aRule] } });
    const loaded = await loadRegistry('/repo/registry.js', importer);
    expect(loaded.rules).toEqual([aRule]);
  });

  test('a default that is directly the rules array', async () => {
    const { importer } = recordingImporter({ default: [aRule] });
    const loaded = await loadRegistry('/repo/registry.js', importer);
    expect(loaded.rules).toEqual([aRule]);
  });

  test('an empty registry is valid (zero rules, no error)', async () => {
    const { importer } = recordingImporter({ META_RULES: [] });
    const loaded = await loadRegistry('/repo/registry.js', importer);
    expect(loaded.error).toBeUndefined();
    expect(loaded.rules).toEqual([]);
  });
});

describe('loadRegistry — rejected registries red the build (fail-safe)', () => {
  test('no META_RULES / default array is an error', async () => {
    const { importer } = recordingImporter({ notRules: 1 });
    const loaded = await loadRegistry('/repo/registry.js', importer);
    expect(loaded.rules).toEqual([]);
    expect(loaded.error).toContain('META_RULES');
  });

  test('an array of non-rule-shaped objects is rejected', async () => {
    const { importer } = recordingImporter({ META_RULES: [{ id: 'x' /* no run */ }] });
    const loaded = await loadRegistry('/repo/registry.js', importer);
    expect(loaded.error).toContain('META_RULES');
  });

  test('an import that throws surfaces the message as an error', async () => {
    const importer: ModuleImporter = () => Promise.reject(new Error('cannot find module'));
    const loaded = await loadRegistry('/repo/registry.js', importer);
    expect(loaded.rules).toEqual([]);
    expect(loaded.error).toBe('cannot find module');
  });
});

describe('loadRegistry — bounded eval (§5)', () => {
  test('imports EXACTLY the enumerated registry, never a stray sibling', async () => {
    const { importer, calls } = recordingImporter({ META_RULES: [aRule] });
    const registryPath = '/repo/.nightcore/lint-meta/registry.js';
    await loadRegistry(registryPath, importer);
    // The one and only import is the declared registry — a stray
    // `/repo/.nightcore/lint-meta/evil.js` is never touched.
    expect(calls).toEqual([registryPath]);
  });

  test('the default registry paths are the fixed, committed locations (TypeScript first)', () => {
    // A fixed, enumerated list — still bounded eval. `.mts` (what the portable-lock
    // exporter emits) wins over `.ts`, which wins over a legacy `.js` registry.
    expect(DEFAULT_REGISTRY_RELATIVE_PATHS).toEqual([
      '.nightcore/lint-meta/registry.mts',
      '.nightcore/lint-meta/registry.ts',
      '.nightcore/lint-meta/registry.js',
    ]);
  });
});

describe('loadRegistry — a failed TypeScript import names the fix (#325)', () => {
  /** An importer that rejects with an Error carrying `code`. */
  function throwing(message: string, code?: string): ModuleImporter {
    return () => {
      const err = new Error(message) as Error & { code?: string };
      if (code !== undefined) err.code = code;
      return Promise.reject(err);
    };
  }

  test('an old Node that cannot strip types is reported as a Node version problem', async () => {
    const loaded = await loadRegistry(
      '/repo/.nightcore/lint-meta/registry.ts',
      throwing('Unknown file extension ".ts" for /repo/.nightcore/lint-meta/registry.ts', 'ERR_UNKNOWN_FILE_EXTENSION'),
    );
    expect(loaded.rules).toEqual([]);
    expect(loaded.error).toContain('22.18');
  });

  test('an ESM registry in a CommonJS scope points at the .mts fix', async () => {
    const loaded = await loadRegistry(
      '/repo/.nightcore/lint-meta/registry.ts',
      throwing('Cannot use import statement outside a module'),
    );
    expect(loaded.error).toContain('.mts');
  });

  test('a registry under node_modules names the type-stripping refusal', async () => {
    const loaded = await loadRegistry(
      '/repo/node_modules/x/registry.ts',
      throwing('boom', 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING'),
    );
    expect(loaded.error).toContain('node_modules');
  });

  test('a JavaScript registry error is passed through verbatim (no TS advice)', async () => {
    const loaded = await loadRegistry(
      '/repo/.nightcore/lint-meta/registry.js',
      throwing('Cannot use import statement outside a module'),
    );
    expect(loaded.error).toBe('Cannot use import statement outside a module');
  });
});
