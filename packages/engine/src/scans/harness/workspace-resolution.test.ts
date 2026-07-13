/// <reference types="bun" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

import { detectWorkspace, resolvePackages } from './workspace-resolution.js';

/**
 * Drive workspace-tool detection + member-package resolution against real
 * tmp-dir fixtures. No Claude, no SDK — pure fs detection, mirroring the
 * degrade-not-throw discipline of `repo-profile.ts`.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-workspace-'));
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

describe('detectWorkspace — tool precedence', () => {
  test('a pnpm-workspace.yaml wins over a package.json `workspaces` field', () => {
    const root = makeRepo();
    writeFile(root, 'pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
    const rootPkg = { name: 'root', workspaces: ['ignored/*'] };

    const { workspaceTool, globs } = detectWorkspace(root, rootPkg, undefined);
    expect(workspaceTool).toBe('pnpm');
    expect(globs).toEqual(['apps/*', 'packages/*']);
  });

  test('a turbo.json marks the tool `turbo`, globs come from `workspaces`', () => {
    const root = makeRepo();
    writeFile(root, 'turbo.json', '{}');
    const rootPkg = { name: 'root', workspaces: ['apps/*'] };

    const { workspaceTool, globs } = detectWorkspace(root, rootPkg, undefined);
    expect(workspaceTool).toBe('turbo');
    expect(globs).toEqual(['apps/*']);
  });

  test('an nx.json marks the tool `nx`, `workspaces.packages` form is parsed', () => {
    const root = makeRepo();
    writeFile(root, 'nx.json', '{}');
    const rootPkg = { name: 'root', workspaces: { packages: ['packages/*'] } };

    const { workspaceTool, globs } = detectWorkspace(root, rootPkg, undefined);
    expect(workspaceTool).toBe('nx');
    expect(globs).toEqual(['packages/*']);
  });

  test('a Cargo `[workspace]` with no node config detects as `cargo`', () => {
    const root = makeRepo();
    const cargo = '[workspace]\nmembers = ["crates/app", "crates/core"]\n';

    const { workspaceTool, globs } = detectWorkspace(root, undefined, cargo);
    expect(workspaceTool).toBe('cargo');
    expect(globs).toEqual(['crates/app', 'crates/core']);
  });
});

describe('detectWorkspace — node tool disambiguation', () => {
  test('an explicit `packageManager` field wins over any lockfile', () => {
    const root = makeRepo();
    writeFile(root, 'yarn.lock', '');
    const rootPkg = { name: 'root', workspaces: ['apps/*'], packageManager: 'bun@1.3.14' };

    expect(detectWorkspace(root, rootPkg, undefined).workspaceTool).toBe('bun');
  });

  test('falls back to a bun lockfile when no `packageManager` is declared', () => {
    const root = makeRepo();
    writeFile(root, 'bun.lock', '');
    const rootPkg = { name: 'root', workspaces: ['apps/*'] };

    expect(detectWorkspace(root, rootPkg, undefined).workspaceTool).toBe('bun');
  });

  test('falls back to a yarn lockfile', () => {
    const root = makeRepo();
    writeFile(root, 'yarn.lock', '');
    const rootPkg = { name: 'root', workspaces: ['apps/*'] };

    expect(detectWorkspace(root, rootPkg, undefined).workspaceTool).toBe('yarn');
  });

  test('defaults to npm with no packageManager and no recognized lockfile', () => {
    const root = makeRepo();
    const rootPkg = { name: 'root', workspaces: ['apps/*'] };

    expect(detectWorkspace(root, rootPkg, undefined).workspaceTool).toBe('npm');
  });
});

describe('detectWorkspace — directory-convention monorepo', () => {
  test('apps/* + packages/* members with no workspace config still detect as a monorepo', () => {
    // No `workspaces` field, no turbo/nx/pnpm config, no root lockfile — just a
    // `packageManager` field and independent-install apps (boringstack-style).
    const root = makeRepo();
    writeJson(root, 'apps/api/package.json', { name: '@x/api' });
    writeJson(root, 'apps/ui/package.json', { name: '@x/ui' });
    const rootPkg = { name: 'boringish', private: true, packageManager: 'bun@1.3.14' };

    const { workspaceTool, globs } = detectWorkspace(root, rootPkg, undefined);
    expect(workspaceTool).toBe('bun');
    expect(globs).toEqual(['apps/*', 'packages/*']);
  });
});

describe('detectWorkspace — single / unknown', () => {
  test('a lone package.json with no workspace signals is `single`', () => {
    const root = makeRepo();
    const rootPkg = { name: 'solo' };

    const { workspaceTool, globs } = detectWorkspace(root, rootPkg, undefined);
    expect(workspaceTool).toBe('single');
    expect(globs).toEqual([]);
  });

  test('a lone Cargo.toml with no `[workspace]` is `single`', () => {
    const root = makeRepo();
    const cargo = '[package]\nname = "solo"\n';

    expect(detectWorkspace(root, undefined, cargo).workspaceTool).toBe('single');
  });

  test('nothing at all is `unknown`', () => {
    const root = makeRepo();
    expect(detectWorkspace(root, undefined, undefined).workspaceTool).toBe('unknown');
  });
});

describe('resolvePackages', () => {
  test('resolves an exact-dir glob only when a manifest is present', () => {
    const root = makeRepo();
    writeJson(root, 'tools/lint-meta/package.json', { name: '@x/lint-meta' });

    const packages = resolvePackages(root, ['tools/lint-meta', 'tools/missing'], 'npm');
    expect(packages).toHaveLength(1);
    expect(packages[0]?.path).toBe('tools/lint-meta');
    expect(packages[0]?.name).toBe('@x/lint-meta');
    expect(packages[0]?.role).toBe('tool');
  });

  test('resolves a `dir/*` glob to every immediate subdir carrying a manifest', () => {
    const root = makeRepo();
    writeJson(root, 'apps/web/package.json', { name: '@x/web' });
    writeJson(root, 'apps/api/package.json', { name: '@x/api' });
    fs.mkdirSync(path.join(root, 'apps', 'no-manifest'), { recursive: true });

    const packages = resolvePackages(root, ['apps/*'], 'npm');
    const paths = packages.map((p) => p.path).sort();
    expect(paths).toEqual(['apps/api', 'apps/web']);
    expect(packages.every((p) => p.role === 'app')).toBe(true);
  });

  test('ignores `!`-negated globs', () => {
    const root = makeRepo();
    writeJson(root, 'apps/web/package.json', { name: '@x/web' });

    const packages = resolvePackages(root, ['apps/*', '!apps/web'], 'npm');
    // The negation itself is a no-op (unsupported), so apps/web still resolves
    // via the `apps/*` glob — this only proves a `!`-prefixed glob is skipped
    // rather than mis-parsed as a literal dir.
    expect(packages.map((p) => p.path)).toContain('apps/web');
  });

  test('cargo tool reads the member name from `Cargo.toml` `[package]`', () => {
    const root = makeRepo();
    writeFile(
      root,
      'crates/app/Cargo.toml',
      '[package]\nname = "app-core"\n\n[dependencies]\ntauri = "2"\n',
    );

    const packages = resolvePackages(root, ['crates/*'], 'cargo');
    expect(packages).toHaveLength(1);
    expect(packages[0]?.name).toBe('app-core');
    expect(packages[0]?.path).toBe('crates/app');
  });

  test('a declared package.json `name` wins over the directory name', () => {
    const root = makeRepo();
    writeJson(root, 'packages/contracts/package.json', { name: '@my/contracts' });

    const packages = resolvePackages(root, ['packages/*'], 'npm');
    expect(packages[0]?.name).toBe('@my/contracts');
    expect(packages[0]?.path).toBe('packages/contracts');
  });
});
