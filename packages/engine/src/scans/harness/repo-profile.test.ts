/// <reference types="bun" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

import { detectRepoProfile } from './repo-profile.js';

/**
 * Drive the deterministic profiler against real tmp-dir fixtures (a fake bun
 * monorepo + a fake single package). No Claude, no SDK — pure fs detection.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Make a fresh tmp repo root (auto-cleaned). */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-profile-'));
  dirs.push(dir);
  return dir;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function writeJson(root: string, rel: string, value: unknown): void {
  writeFile(root, rel, JSON.stringify(value, null, 2));
}

describe('detectRepoProfile — monorepo', () => {
  function buildMonorepo(): string {
    const root = makeRepo();
    writeJson(root, 'package.json', {
      name: 'my-monorepo',
      private: true,
      workspaces: ['apps/*', 'packages/*', 'tools/*'],
      devDependencies: { 'eslint-plugin-nightcore': '1.0.0' },
    });
    writeFile(root, 'bun.lockb', '');
    writeFile(root, 'CLAUDE.md', '# Agent guide\n');
    writeFile(root, 'eslint.config.js', 'export default [];\n');
    writeFile(root, 'tsconfig.json', '{}');
    // apps/web — a react app.
    writeJson(root, 'apps/web/package.json', {
      name: '@my/web',
      dependencies: { react: '18.0.0', vite: '5.0.0' },
    });
    // packages/contracts — a library.
    writeJson(root, 'packages/contracts/package.json', {
      name: '@my/contracts',
      devDependencies: { typescript: '5.6.0' },
    });
    // tools/lint-meta — the meta rule engine.
    writeJson(root, 'tools/lint-meta/package.json', {
      name: '@my/lint-meta',
      scripts: { 'lint:meta': 'node cli.js' },
    });
    return root;
  }

  test('detects monorepo shape, tool, packages, frameworks, docs, plugins', () => {
    const profile = detectRepoProfile(buildMonorepo());

    expect(profile.isMonorepo).toBe(true);
    expect(profile.workspaceTool).toBe('bun');

    const byPath = new Map(profile.packages.map((p) => [p.path, p]));
    expect(byPath.has('apps/web')).toBe(true);
    expect(byPath.get('apps/web')?.role).toBe('app');
    expect(byPath.get('apps/web')?.name).toBe('@my/web');
    expect(byPath.get('packages/contracts')?.role).toBe('package');
    expect(byPath.get('tools/lint-meta')?.role).toBe('tool');

    expect(profile.languages).toContain('typescript');
    expect(profile.frameworks.sort()).toEqual(['react', 'vite']);
    expect(profile.hasEslintFlatConfig).toBe(true);
    expect(profile.hasAgentDocs).toBe(true);
    expect(profile.hasLintMeta).toBe(true);
    expect(profile.existingPlugins).toEqual(['eslint-plugin-nightcore']);
  });
});

describe('detectRepoProfile — single package', () => {
  test('a lone package.json with no workspaces is `single`, not a monorepo', () => {
    const root = makeRepo();
    writeJson(root, 'package.json', {
      name: 'solo',
      dependencies: { express: '4.0.0' },
    });
    writeFile(root, 'tsconfig.json', '{}');

    const profile = detectRepoProfile(root);
    expect(profile.isMonorepo).toBe(false);
    expect(profile.workspaceTool).toBe('single');
    expect(profile.packages).toHaveLength(0);
    expect(profile.frameworks).toEqual(['express']);
    expect(profile.languages).toContain('typescript');
    expect(profile.hasAgentDocs).toBe(false);
    expect(profile.existingPlugins).toEqual([]);
  });
});

describe('detectRepoProfile — directory-convention monorepo', () => {
  test('apps/* members with no `workspaces` field still detect as a monorepo (boringstack-style)', () => {
    // No workspaces field, no turbo/nx/pnpm config, no root lockfile — just a
    // `private` root with `packageManager` and independent-install apps. The
    // tool label comes from `packageManager`; members come from apps/* + packages/*.
    const root = makeRepo();
    writeJson(root, 'package.json', {
      name: 'boringish',
      private: true,
      packageManager: 'bun@1.3.14',
    });
    writeFile(root, 'AGENTS.md', '# Agents\n');
    writeJson(root, 'apps/api/package.json', {
      name: '@x/api',
      dependencies: { elysia: '1.0.0' },
    });
    writeFile(root, 'apps/api/index.ts', 'export {}\n');
    writeJson(root, 'apps/ui/package.json', {
      name: '@x/ui',
      dependencies: { react: '18.0.0', vite: '5.0.0' },
    });

    const profile = detectRepoProfile(root);
    expect(profile.isMonorepo).toBe(true);
    expect(profile.workspaceTool).toBe('bun');
    const paths = profile.packages.map((p) => p.path).sort();
    expect(paths).toEqual(['apps/api', 'apps/ui']);
    expect(profile.frameworks.sort()).toEqual(['elysia', 'react', 'vite']);
    expect(profile.languages).toContain('typescript');
    expect(profile.hasAgentDocs).toBe(true);
  });
});

describe('detectRepoProfile — cargo workspace', () => {
  test('detects a Cargo `[workspace]` with members and tauri', () => {
    const root = makeRepo();
    writeFile(
      root,
      'Cargo.toml',
      '[workspace]\nmembers = ["crates/app"]\n',
    );
    writeFile(
      root,
      'crates/app/Cargo.toml',
      '[package]\nname = "app-core"\n\n[dependencies]\ntauri = "2"\n',
    );

    const profile = detectRepoProfile(root);
    expect(profile.workspaceTool).toBe('cargo');
    expect(profile.isMonorepo).toBe(true);
    expect(profile.languages).toContain('rust');
    expect(profile.frameworks).toContain('tauri');
    expect(profile.packages[0]?.name).toBe('app-core');
    expect(profile.packages[0]?.path).toBe('crates/app');
  });
});

describe('detectRepoProfile — empty / garbage', () => {
  test('an empty dir profiles as `unknown` without throwing', () => {
    const profile = detectRepoProfile(makeRepo());
    expect(profile.workspaceTool).toBe('unknown');
    expect(profile.isMonorepo).toBe(false);
    expect(profile.packages).toEqual([]);
    expect(profile.frameworks).toEqual([]);
  });

  test('a nonexistent path profiles as `unknown` without throwing', () => {
    const profile = detectRepoProfile('/no/such/path/nc-harness-test');
    expect(profile.workspaceTool).toBe('unknown');
    expect(profile.isMonorepo).toBe(false);
  });

  test('garbage package.json degrades to conservative defaults', () => {
    const root = makeRepo();
    writeFile(root, 'package.json', '{ this is not json');
    const profile = detectRepoProfile(root);
    // Unparseable manifest ⇒ treated as absent ⇒ `unknown`.
    expect(profile.workspaceTool).toBe('unknown');
  });
});
