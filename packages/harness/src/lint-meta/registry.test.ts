import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_REGISTRY_RELATIVE_PATH,
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

  test('the default registry path is the fixed, committed location', () => {
    expect(DEFAULT_REGISTRY_RELATIVE_PATH).toBe('.nightcore/lint-meta/registry.js');
  });
});
