/**
 * Deterministic repo profiling for the Harness feature — a cheap, synchronous
 * filesystem pass that detects the SHAPE of a target repo (monorepo? which tool?
 * which packages/languages/frameworks? is there an eslint/lint-meta/agent-doc
 * setup already?). NO Claude, no SDK: this grounds the synthesis pass (what stack
 * to generate a harness for) and the UI ProfileBanner, and the headline
 * `isMonorepo` decides whether plugin/lint-meta artifacts are proposed at all.
 *
 * Every read is wrapped in try/catch and NEVER throws: a missing or garbage file
 * collapses to conservative defaults so a malformed repo still yields a usable
 * profile rather than a crash. Mirrors the degrade-not-throw discipline of the
 * rest of the engine.
 *
 * Workspace-tool detection + member-package resolution live in
 * `workspace-resolution.ts`; the shared fs read primitives live in
 * `fs-probe.ts`.
 */
import * as path from 'node:path';

import type { RepoPackage, RepoProfile } from '@nightcore/contracts';

import { asRecord, dirExists, fileExists, listFiles, readJson, readText } from './fs-probe.js';
import { detectWorkspace, resolvePackages } from './workspace-resolution.js';

/** Dependency name → emitted framework label. Matched against the merged
 *  deps/devDeps of every scanned package.json. */
const FRAMEWORK_DEPS: Record<string, string> = {
  react: 'react',
  vue: 'vue',
  svelte: 'svelte',
  'solid-js': 'solid',
  next: 'next',
  elysia: 'elysia',
  express: 'express',
  fastify: 'fastify',
  '@nestjs/core': 'nest',
  '@tauri-apps/api': 'tauri',
  vite: 'vite',
  astro: 'astro',
};

/**
 * Detect the deterministic {@link RepoProfile} of the repo rooted at
 * `projectPath`. Pure synchronous fs reads; never throws.
 */
export function detectRepoProfile(projectPath: string): RepoProfile {
  const root = path.resolve(projectPath);
  const rootPkg = readJson(path.join(root, 'package.json'));
  const rootCargo = readText(path.join(root, 'Cargo.toml'));

  const { workspaceTool, globs } = detectWorkspace(root, rootPkg, rootCargo);
  const isMonorepo = workspaceTool !== 'single' && workspaceTool !== 'unknown';
  const packages = resolvePackages(root, globs, workspaceTool);

  // The dirs every "root or member" heuristic scans: the repo root + each member.
  const scanDirs = [root, ...packages.map((p) => path.join(root, p.path))];
  // Every package.json across root + members, read once and reused.
  const pkgManifests = [rootPkg, ...packages.map((p) =>
    readJson(path.join(root, p.path, 'package.json')),
  )];
  // Every Cargo.toml across root + members (for the rust + tauri heuristics).
  const cargoTexts = [rootCargo, ...packages.map((p) =>
    readText(path.join(root, p.path, 'Cargo.toml')),
  )];

  return {
    isMonorepo,
    workspaceTool,
    packages,
    languages: detectLanguages(scanDirs, cargoTexts),
    frameworks: detectFrameworks(pkgManifests, cargoTexts),
    hasEslintFlatConfig: scanDirs.some(hasEslintFlatConfig),
    hasLintMeta: detectLintMeta(root, packages, pkgManifests),
    hasAgentDocs: scanDirs.some(hasAgentDocs),
    existingPlugins: detectExistingPlugins(pkgManifests),
  };
}

/** Languages present at root or in any member (heuristic, shallow). */
function detectLanguages(
  scanDirs: string[],
  cargoTexts: Array<string | undefined>,
): string[] {
  const langs = new Set<string>();
  if (scanDirs.some(hasTypeScript)) langs.add('typescript');
  if (cargoTexts.some((c) => c !== undefined)) langs.add('rust');
  if (scanDirs.some((d) => fileExists(path.join(d, 'go.mod')))) langs.add('go');
  if (
    scanDirs.some(
      (d) =>
        fileExists(path.join(d, 'pyproject.toml')) ||
        fileExists(path.join(d, 'setup.py')),
    )
  ) {
    langs.add('python');
  }
  return [...langs];
}

/** TypeScript if a `tsconfig*.json` or any `.ts`/`.tsx` file sits at the dir top. */
function hasTypeScript(dir: string): boolean {
  for (const name of listFiles(dir)) {
    if (/^tsconfig.*\.json$/.test(name)) return true;
    if (/\.tsx?$/.test(name)) return true;
  }
  return false;
}

/** Frameworks across every scanned package.json (+ Cargo.toml for tauri). */
function detectFrameworks(
  pkgManifests: Array<Record<string, unknown> | undefined>,
  cargoTexts: Array<string | undefined>,
): string[] {
  const found = new Set<string>();
  for (const pkg of pkgManifests) {
    for (const dep of Object.keys(mergedDeps(pkg))) {
      const label = FRAMEWORK_DEPS[dep];
      if (label !== undefined) found.add(label);
      else if (dep.startsWith('@tauri-apps/')) found.add('tauri');
      else if (dep.startsWith('@nestjs/')) found.add('nest');
    }
  }
  for (const cargo of cargoTexts) {
    if (cargo !== undefined && /^\s*tauri\b\s*[=.]/m.test(cargo)) found.add('tauri');
  }
  return [...found];
}

/** An eslint flat config sits at the dir top. */
function hasEslintFlatConfig(dir: string): boolean {
  return (
    fileExists(path.join(dir, 'eslint.config.js')) ||
    fileExists(path.join(dir, 'eslint.config.mjs')) ||
    fileExists(path.join(dir, 'eslint.config.cjs')) ||
    fileExists(path.join(dir, 'eslint.config.ts'))
  );
}

/** A CLAUDE.md / AGENTS.md / AGENT_CONTRACT.md agent doc sits at the dir top. */
function hasAgentDocs(dir: string): boolean {
  return (
    fileExists(path.join(dir, 'CLAUDE.md')) ||
    fileExists(path.join(dir, 'AGENTS.md')) ||
    fileExists(path.join(dir, 'AGENT_CONTRACT.md'))
  );
}

/** A `lint-meta` engine: a `lint-meta` dir under a known parent, a member named
 *  `lint-meta`, or a `lint:meta` package script. */
function detectLintMeta(
  root: string,
  packages: RepoPackage[],
  pkgManifests: Array<Record<string, unknown> | undefined>,
): boolean {
  if (
    dirExists(path.join(root, 'lint-meta')) ||
    dirExists(path.join(root, 'tools', 'lint-meta')) ||
    dirExists(path.join(root, 'tooling', 'lint-meta')) ||
    dirExists(path.join(root, 'scripts', 'lint-meta')) ||
    dirExists(path.join(root, 'packages', 'lint-meta'))
  ) {
    return true;
  }
  if (packages.some((p) => (p.path.split('/').pop() ?? '') === 'lint-meta')) {
    return true;
  }
  return pkgManifests.some((pkg) => {
    const scripts = pkg?.scripts;
    return (
      typeof scripts === 'object' &&
      scripts !== null &&
      typeof (scripts as Record<string, unknown>)['lint:meta'] === 'string'
    );
  });
}

/** Custom ESLint plugin package names wired anywhere in the repo. */
function detectExistingPlugins(
  pkgManifests: Array<Record<string, unknown> | undefined>,
): string[] {
  const plugins = new Set<string>();
  for (const pkg of pkgManifests) {
    for (const dep of Object.keys(mergedDeps(pkg))) {
      if (/eslint-plugin/.test(dep)) plugins.add(dep);
    }
  }
  return [...plugins].sort();
}

/** Merge `dependencies` + `devDependencies` of a package.json into one map. */
function mergedDeps(
  pkg: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const deps = asRecord(pkg?.dependencies);
  const devDeps = asRecord(pkg?.devDependencies);
  return { ...deps, ...devDeps };
}
