import { afterAll, describe, expect, test } from 'bun:test';

import { createOnlyBuiltDependenciesHaveScriptsRule } from './only-built-dependencies-have-scripts.js';
import { createFixture, messages, removeFixtures, runSync } from './test-support.js';

afterAll(removeFixtures);

const RULE = createOnlyBuiltDependenciesHaveScriptsRule();

/** A package as pnpm's virtual store lays it out, keyed by repo-relative path. */
function stored(
  name: string,
  version: string,
  scripts: Record<string, string> = {},
  extra: Record<string, string> = {},
): Record<string, string> {
  const dir = `node_modules/.pnpm/${name.replace('/', '+')}@${version}/node_modules/${name}`;
  const files: Record<string, string> = {
    [`${dir}/package.json`]: JSON.stringify({ name, version, scripts }),
  };
  for (const [file, content] of Object.entries(extra)) files[`${dir}/${file}`] = content;
  return files;
}

function manifest(only: string[], ignored?: string[]): string {
  return JSON.stringify({
    name: 'fixture',
    pnpm: {
      onlyBuiltDependencies: only,
      ...(ignored === undefined ? {} : { ignoredBuiltDependencies: ignored }),
      overrides: {},
    },
  });
}

const TREE = {
  ...stored('esbuild', '0.28.2', { postinstall: 'node install.js' }),
  ...stored('@parcel/watcher', '2.5.1', { install: 'node scripts/build-from-source.js' }),
  ...stored('protobufjs', '7.6.5', { postinstall: 'node scripts/postinstall' }),
  ...stored('is-number', '7.0.0', { test: 'mocha' }),
};

function run(files: Record<string, string>): string[] {
  return messages(runSync(RULE, createFixture(files).ctx()));
}

describe('only-built-dependencies-have-scripts', () => {
  test('passes when every listed package has a build step and every package with one is listed once', () => {
    expect(
      run({ ...TREE, 'package.json': manifest(['esbuild', '@parcel/watcher'], ['protobufjs']) }),
    ).toEqual([]);
  });

  test('reports a listed package that has no install script', () => {
    const found = run({
      ...TREE,
      'package.json': manifest(['esbuild', '@parcel/watcher', 'is-number'], ['protobufjs']),
    });
    expect(found).toHaveLength(1);
    expect(found[0] ?? '').toMatch(
      /"is-number" is in onlyBuiltDependencies but no installed version has a preinstall, install or postinstall script/u,
    );
  });

  test('reports a listed package that is not installed', () => {
    const found = run({
      ...TREE,
      'package.json': manifest(['esbuild', '@parcel/watcher'], ['protobufjs', 'left-pad']),
    });
    expect(found).toHaveLength(1);
    expect(found[0] ?? '').toMatch(/"left-pad" is in ignoredBuiltDependencies but is not installed/u);
  });

  test('reports a package with an install script that neither list names', () => {
    const found = run({ ...TREE, 'package.json': manifest(['esbuild'], ['protobufjs']) });
    expect(found).toHaveLength(1);
    expect(found[0] ?? '').toMatch(
      /"@parcel\/watcher" \(2\.5\.1\) has a build step \(install\) but is in neither onlyBuiltDependencies nor ignoredBuiltDependencies/u,
    );
  });

  test('reports a package named in both lists', () => {
    const found = run({
      ...TREE,
      'package.json': manifest(['esbuild', '@parcel/watcher', 'protobufjs'], ['protobufjs']),
    });
    expect(found).toHaveLength(1);
    expect(found[0] ?? '').toMatch(
      /"protobufjs" is in both onlyBuiltDependencies and ignoredBuiltDependencies/u,
    );
  });

  test('counts a binding.gyp or a .hooks directory as a build step, as pnpm does', () => {
    const found = run({
      ...TREE,
      ...stored('native-thing', '1.0.0', {}, { 'binding.gyp': '{}' }),
      ...stored('hooked', '2.0.0', {}, { '.hooks/postinstall': '#!/bin/sh\n' }),
      'package.json': manifest(['esbuild', '@parcel/watcher'], ['protobufjs']),
    });
    expect(found).toHaveLength(2);
    expect(found[0] ?? '').toMatch(/"hooked" \(2\.0\.0\) has a build step \(\.hooks\/\)/u);
    expect(found[1] ?? '').toMatch(/"native-thing" \(1\.0\.0\) has a build step \(binding\.gyp\)/u);
  });

  test('reads the lists from pnpm-workspace.yaml as well, and reports a build setting it does not read', () => {
    const found = run({
      ...TREE,
      'package.json': JSON.stringify({ name: 'fixture' }),
      'pnpm-workspace.yaml':
        "packages:\n  - 'apps/*'\nonlyBuiltDependencies:\n  - esbuild\n  - '@parcel/watcher'\nignoredBuiltDependencies:\n  - protobufjs\nallowBuilds:\n  esbuild: true\n",
    });
    expect(found).toHaveLength(1);
    expect(found[0] ?? '').toMatch(/`allowBuilds` is set/u);
  });

  test('reports a workspace list it cannot read, and a manifest that is not JSON', () => {
    const found = run({
      ...TREE,
      'package.json': '{ not json',
      'pnpm-workspace.yaml':
        "onlyBuiltDependencies: [esbuild]\nignoredBuiltDependencies:\n  - protobufjs\n  - '@parcel/watcher'\n",
    });
    expect(found.some((message) => /package\.json is not valid JSON/u.test(message))).toBe(true);
    expect(found.some((message) => /`onlyBuiltDependencies` holds "\[esbuild\]"/u.test(message))).toBe(
      true,
    );
  });

  test('reports a tree with nothing installed instead of passing it', () => {
    const found = run({ 'package.json': manifest(['esbuild'], []) });
    expect(found[0] ?? '').toMatch(/node_modules\/\.pnpm does not exist/u);
  });
});
