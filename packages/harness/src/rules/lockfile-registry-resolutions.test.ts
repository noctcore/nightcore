import { afterAll, describe, expect, test } from 'bun:test';

import { createLockfileRegistryResolutionsRule } from './lockfile-registry-resolutions.js';
import { createFixture, messages, removeFixtures, runSync } from './test-support.js';

afterAll(removeFixtures);

const RULE = createLockfileRegistryResolutionsRule();
const INTEGRITY =
  'sha512-aPqePoZIqwlAchbgbFDO/wHqGB+7H1nj9gaM+OsL9h77S5S3TnLd9BgD3LnoeDikULo7cl2HSUrEyQ55Z7DYbg==';

/** A version 9 lockfile whose `packages:` section holds the given entries, verbatim. */
function lockfile(entries: string): string {
  return [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    devDependencies:',
    '      is-number:',
    '        specifier: ^7.0.0',
    '        version: 7.0.0',
    '',
    '  packages/a:',
    '    dependencies:',
    '      b:',
    '        specifier: workspace:*',
    '        version: link:../b',
    '',
    'packages:',
    '',
    entries,
    'snapshots:',
    '',
    '  is-number@7.0.0: {}',
    '',
  ].join('\n');
}

const REGISTRY_ENTRY = `  is-number@7.0.0:\n    resolution: {integrity: ${INTEGRITY}}\n    engines: {node: '>=0.12.0'}\n\n`;

function run(entries: string): string[] {
  const fixture = createFixture({ 'pnpm-lock.yaml': lockfile(entries) });
  return messages(runSync(RULE, fixture.ctx()));
}

describe('lockfile-registry-resolutions', () => {
  test('is a strict supply-chain rule', () => {
    expect(RULE.id).toBe('lockfile-registry-resolutions');
    expect(RULE.ciCritical).toBe(true);
    expect(RULE.baseline).toBeUndefined();
  });

  test('passes a lockfile whose every package resolves from the registry with an integrity hash', () => {
    expect(run(REGISTRY_ENTRY)).toEqual([]);
  });

  test('reports a package resolved from a git repository', () => {
    const found = run(
      `${REGISTRY_ENTRY}  is-odd@https://codeload.github.com/x/is-odd/tar.gz/98e8ff1:\n    resolution: {tarball: https://codeload.github.com/x/is-odd/tar.gz/98e8ff1}\n    version: 3.0.1\n\n  left-pad@git+https://github.com/x/left-pad.git#5f8b2e1:\n    resolution: {commit: 5f8b2e1, repo: https://github.com/x/left-pad.git, type: git}\n    version: 1.3.0\n\n`,
    );
    expect(found).toHaveLength(2);
    expect(found[0] ?? '').toMatch(
      /"is-odd@https:\/\/codeload\.github\.com\/x\/is-odd\/tar\.gz\/98e8ff1" resolves from a tarball URL/u,
    );
    expect(found[1] ?? '').toMatch(
      /"left-pad@git\+https:\/\/github\.com\/x\/left-pad\.git#5f8b2e1" resolves from a git repository/u,
    );
  });

  test('reports a package resolved from a local directory', () => {
    const found = run(
      `${REGISTRY_ENTRY}  a@file:vendor/a:\n    resolution: {directory: vendor/a, type: directory}\n    version: 1.0.0\n\n`,
    );
    expect(found).toHaveLength(1);
    expect(found[0] ?? '').toMatch(/"a@file:vendor\/a" resolves from a local directory/u);
  });

  test('reports a package with no integrity hash, or with no resolution at all', () => {
    const found = run(
      `  is-even@1.0.0:\n    resolution: {integrity: ''}\n\n  is-odd@3.0.1:\n    engines: {node: '>=4'}\n\n`,
    );
    expect(found).toHaveLength(2);
    expect(found[0] ?? '').toMatch(/"is-even@1\.0\.0" carries no sha512 integrity/u);
    expect(found[1] ?? '').toMatch(/"is-odd@3\.0\.1" has no resolution line/u);
  });

  test('reports a resolution written over several lines instead of reading past it', () => {
    const found = run(`  is-even@1.0.0:\n    resolution:\n      integrity: ${INTEGRITY}\n\n`);
    expect(found).toHaveLength(1);
    expect(found[0] ?? '').toMatch(/"is-even@1\.0\.0" carries no sha512 integrity/u);
  });

  test('reports a tarball URL even when it carries an integrity hash', () => {
    // A dependency spelled as a tarball URL on the registry's own host is not
    // refused by blockExoticSubdeps, and a second registry configured for one
    // scope writes the same shape: both are a source the repo has not chosen,
    // whatever hash they carry.
    const found = run(
      `  is-even@1.0.0:\n    resolution: {integrity: ${INTEGRITY}, tarball: https://npm.example.com/is-even/-/is-even-1.0.0.tgz}\n\n`,
    );
    expect(found).toHaveLength(1);
    expect(found[0] ?? '').toMatch(/"is-even@1\.0\.0" resolves from a tarball URL/u);
  });

  test('reports a key line it cannot read instead of letting the next resolution land on the entry above', () => {
    // A trailing comment on the key line: read loosely, the git resolution
    // below it would overwrite is-number's line and vanish.
    const found = run(
      `${REGISTRY_ENTRY}  left-pad@1.3.0: # vendored\n    resolution: {commit: 5f8b2e1, repo: https://github.com/x/left-pad.git, type: git}\n\n`,
    );
    expect(found).toHaveLength(2);
    expect(found[0] ?? '').toMatch(/cannot read the line "left-pad@1\.3\.0: # vendored"/u);
    expect(found[1] ?? '').toMatch(/"is-number@7\.0\.0" has two resolution lines/u);
  });

  test('reports a resolution field it does not know, or a quoted one, instead of skipping it', () => {
    const quoted = run(
      `  is-even@1.0.0:\n    resolution: {integrity: ${INTEGRITY}, 'tarball': https://npm.example.com/is-even-1.0.0.tgz}\n\n`,
    );
    expect(quoted).toHaveLength(1);
    expect(quoted[0] ?? '').toMatch(/"is-even@1\.0\.0" has a resolution this rule cannot read/u);
    const unknown = run(
      `  is-even@1.0.0:\n    resolution: {integrity: ${INTEGRITY}, path: vendor}\n\n`,
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0] ?? '').toMatch(/has a resolution this rule cannot read/u);
  });

  test('reports a line under packages: at an indent no entry uses', () => {
    const found = run(`${REGISTRY_ENTRY}   odd-indent@1.0.0:\n`);
    expect(found).toHaveLength(1);
    expect(found[0] ?? '').toMatch(/cannot read the line "odd-indent@1\.0\.0:"/u);
  });

  test('reports a missing lockfile, an unknown lockfile version and a lockfile with no packages section', () => {
    const none = messages(runSync(RULE, createFixture().ctx()));
    expect(none[0] ?? '').toMatch(/no pnpm-lock\.yaml/u);

    const older = createFixture({
      'pnpm-lock.yaml': lockfile(REGISTRY_ENTRY).replace("'9.0'", "'6.0'"),
    });
    expect(messages(runSync(RULE, older.ctx()))[0] ?? '').toMatch(/lockfileVersion '6\.0'/u);

    const empty = createFixture({ 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n\nimporters:\n" });
    expect(messages(runSync(RULE, empty.ctx()))[0] ?? '').toMatch(/no packages: section/u);
  });

  test('reads the lockfile at a configured path and names it in every report', () => {
    const rule = createLockfileRegistryResolutionsRule({ lockfile: 'sub/pnpm-lock.yaml' });
    const fixture = createFixture({
      'sub/pnpm-lock.yaml': lockfile(`  is-even@1.0.0:\n    engines: {}\n\n`),
    });
    const found = runSync(rule, fixture.ctx());
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe('sub/pnpm-lock.yaml');
    expect(rule.description).toContain('sub/pnpm-lock.yaml');
  });
});
