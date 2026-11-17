import { afterAll, describe, expect, test } from 'bun:test';

import { createSingleVersionDependenciesRule } from './single-version-dependencies.js';
import { createFixture, messages, removeFixtures, runSync } from './test-support.js';

afterAll(removeFixtures);

const PACKAGES = ['typescript', '@types/node', 'eslint', 'react', 'react-dom'];
const RULE = createSingleVersionDependenciesRule({ packages: PACKAGES });
const HASH =
  'sha512-aPqePoZIqwlAchbgbFDO/wHqGB+7H1nj9gaM+OsL9h77S5S3TnLd9BgD3LnoeDikULo7cl2HSUrEyQ55Z7DYbg==';

/** A lockfile whose `packages:` section holds one entry per `name@version` key. */
function lockfile(keys: readonly string[]): string {
  const entries = keys
    .map((key) => `  '${key}':\n    resolution: {integrity: ${HASH}}\n`)
    .join('\n');
  return `lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\npackages:\n\n${entries}\nsnapshots:\n\n  x@1.0.0: {}\n`;
}

const ONE_EACH = [
  'typescript@5.9.3',
  '@types/node@22.20.4',
  'eslint@10.10.0',
  'react@19.3.0',
  'react-dom@19.3.0',
  'zod@3.25.76',
  'zod@4.6.5',
];

function run(keys: readonly string[]): string[] {
  const fixture = createFixture({ 'pnpm-lock.yaml': lockfile(keys) });
  return messages(runSync(RULE, fixture.ctx()));
}

describe('single-version-dependencies', () => {
  test('names the configured packages in its description, as a strict rule', () => {
    expect(RULE.description).toContain('typescript, @types/node, eslint, react, react-dom');
    expect(RULE.ciCritical).toBe(true);
  });

  test('refuses an empty package list, which would check nothing', () => {
    expect(() => createSingleVersionDependenciesRule({ packages: [] })).toThrow(
      /needs at least one package/u,
    );
  });

  test('passes one version of each, whatever other packages resolve more than once', () => {
    expect(run(ONE_EACH)).toEqual([]);
  });

  test('reports a listed package that resolves to two versions', () => {
    const found = run([...ONE_EACH, 'typescript@6.0.3', '@types/node@24.1.0']);
    expect(found).toHaveLength(2);
    expect(found[0] ?? '').toMatch(
      /"typescript" resolves to 2 versions in pnpm-lock\.yaml \(5\.9\.3, 6\.0\.3\)/u,
    );
    expect(found[1] ?? '').toMatch(
      /"@types\/node" resolves to 2 versions in pnpm-lock\.yaml \(22\.20\.4, 24\.1\.0\)/u,
    );
  });

  test('counts one version under several peer sets as one version', () => {
    expect(run([...ONE_EACH, 'react-dom@19.3.0(react@19.3.0)'])).toEqual([]);
  });

  test('reports a listed package the lockfile no longer holds, instead of passing it', () => {
    const found = run(ONE_EACH.filter((key) => !key.startsWith('react-dom@')));
    expect(found).toHaveLength(1);
    expect(found[0] ?? '').toMatch(/"react-dom" is not in pnpm-lock\.yaml/u);
  });

  test('reports a lockfile it cannot read, or none at all', () => {
    const fixture = createFixture({ 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" });
    expect(messages(runSync(RULE, fixture.ctx()))[0] ?? '').toMatch(/has no packages: section/u);
    expect(messages(runSync(RULE, createFixture().ctx()))[0] ?? '').toMatch(/is missing/u);
  });
});
