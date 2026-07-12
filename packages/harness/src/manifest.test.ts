import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_CHECK_TIMEOUT_MS,
  type FileReader,
  loadChecks,
  manifestPath,
  planCheck,
} from './manifest.js';

const DIR = '/repo';

/** A reader that returns a fixed body regardless of path. */
function reader(body: string | null): FileReader {
  return () => body;
}

describe('planCheck (command planning, mirrors plan_check)', () => {
  test('splits the command on whitespace into program + args', () => {
    const planned = planCheck({ name: 'lint', kind: 'lint-plugin', command: 'npx  eslint   .' });
    expect(planned).not.toBeNull();
    expect(planned?.program).toBe('npx');
    expect(planned?.args).toEqual(['eslint', '.']);
    expect(planned?.command).toBe('npx  eslint   .');
    expect(planned?.timeoutMs).toBe(DEFAULT_CHECK_TIMEOUT_MS);
  });

  test('a blank or absent command is skipped', () => {
    expect(planCheck({ name: 'a', kind: 'lint-plugin', command: '   ' })).toBeNull();
    expect(planCheck({ name: 'a', kind: 'lint-plugin' })).toBeNull();
  });

  test('a disabled check is skipped', () => {
    expect(
      planCheck({ name: 'a', kind: 'lint-plugin', command: 'x', enabled: false }),
    ).toBeNull();
    // enabled defaults to true.
    expect(planCheck({ name: 'a', kind: 'lint-plugin', command: 'x' })).not.toBeNull();
  });

  test('a shell-kind check is skipped (its execution is a deferred fast-follow)', () => {
    expect(planCheck({ name: 'a', kind: 'shell', command: 'rg --count foo' })).toBeNull();
  });

  test('an unknown/future kind with a command still runs (forward-compat)', () => {
    const planned = planCheck({ name: 'a', kind: 'some-future-kind', command: 'do it' });
    expect(planned?.kind).toBe('some-future-kind');
    expect(planned?.program).toBe('do');
  });

  test('a malformed entry (non-object, missing name) is skipped', () => {
    expect(planCheck(null)).toBeNull();
    expect(planCheck('nope')).toBeNull();
    expect(planCheck({ kind: 'lint-plugin', command: 'x' })).toBeNull();
    expect(planCheck({ name: '  ', kind: 'lint-plugin', command: 'x' })).toBeNull();
  });

  test('timeoutMs is honored when > 0, else falls back to the default', () => {
    expect(planCheck({ name: 'a', kind: 'k', command: 'x', timeoutMs: 5000 })?.timeoutMs).toBe(5000);
    expect(planCheck({ name: 'a', kind: 'k', command: 'x', timeoutMs: 0 })?.timeoutMs).toBe(
      DEFAULT_CHECK_TIMEOUT_MS,
    );
    expect(planCheck({ name: 'a', kind: 'k', command: 'x', timeoutMs: -1 })?.timeoutMs).toBe(
      DEFAULT_CHECK_TIMEOUT_MS,
    );
  });
});

describe('loadChecks (opt-in-by-presence, mirrors load_checks)', () => {
  test('reads the manifest at <dir>/.nightcore/harness.json', () => {
    let seen = '';
    loadChecks(DIR, (p) => {
      seen = p;
      return null;
    });
    expect(seen).toBe(manifestPath(DIR));
  });

  test('an absent / unreadable manifest yields no-config (exit 0)', () => {
    expect(loadChecks(DIR, reader(null))).toEqual({ kind: 'no-config' });
  });

  test('malformed JSON yields no-config (warn-and-skip everything)', () => {
    expect(loadChecks(DIR, reader('{ not json'))).toEqual({ kind: 'no-config' });
  });

  test('a manifest with no checks array yields no-config', () => {
    expect(loadChecks(DIR, reader(JSON.stringify({ policy: {} })))).toEqual({ kind: 'no-config' });
  });

  test('a non-object JSON body yields no-config', () => {
    expect(loadChecks(DIR, reader('42'))).toEqual({ kind: 'no-config' });
  });

  test('an absent schemaVersion is treated as v1 and proceeds', () => {
    const out = loadChecks(
      DIR,
      reader(JSON.stringify({ checks: [{ name: 'a', kind: 'k', command: 'x' }] })),
    );
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') expect(out.checks).toHaveLength(1);
  });

  test('schemaVersion 1 proceeds', () => {
    const out = loadChecks(DIR, reader(JSON.stringify({ schemaVersion: 1, checks: [] })));
    expect(out).toEqual({ kind: 'ready', checks: [] });
  });

  test('a higher MAJOR schemaVersion is rejected (upgrade the runner)', () => {
    const out = loadChecks(DIR, reader(JSON.stringify({ schemaVersion: 2, checks: [] })));
    expect(out).toEqual({ kind: 'schema-too-new', found: 2 });
  });

  test('an unparseable schemaVersion is rejected fail-safe', () => {
    const out = loadChecks(DIR, reader(JSON.stringify({ schemaVersion: 'nonsense', checks: [] })));
    expect(out.kind).toBe('schema-too-new');
  });

  test('disabled and command-less entries are dropped from the plan', () => {
    const out = loadChecks(
      DIR,
      reader(
        JSON.stringify({
          checks: [
            { name: 'runs', kind: 'lint-plugin', command: 'npx eslint .' },
            { name: 'off', kind: 'lint-plugin', command: 'x', enabled: false },
            { name: 'nocmd', kind: 'lint-plugin' },
            { name: 'shell', kind: 'shell', command: 'rg foo' },
          ],
        }),
      ),
    );
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') {
      expect(out.checks.map((c) => c.name)).toEqual(['runs']);
    }
  });
});
