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
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { RepoPackage, RepoProfile, WorkspaceTool } from '@nightcore/contracts';

/** Cap on discovered workspace members — keeps a pathological glob from listing
 *  thousands of dirs. */
const MAX_PACKAGES = 50;

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

/** Decide the workspace tool + the package globs to resolve members from. The
 *  tool label follows a fixed precedence (pnpm → turbo → nx → package.json
 *  `workspaces` → cargo); the globs come from whichever source actually lists
 *  members. */
function detectWorkspace(
  root: string,
  rootPkg: Record<string, unknown> | undefined,
  rootCargo: string | undefined,
): { workspaceTool: WorkspaceTool; globs: string[] } {
  const pnpmYaml = readText(path.join(root, 'pnpm-workspace.yaml'));
  const hasTurbo = fileExists(path.join(root, 'turbo.json'));
  const hasNx = fileExists(path.join(root, 'nx.json'));
  const pkgGlobs = parsePkgWorkspaces(rootPkg);
  const cargoIsWorkspace = rootCargo !== undefined && /\[workspace\]/.test(rootCargo);

  // Globs (member sources), independent of the chosen label.
  const globs =
    pnpmYaml !== undefined
      ? parsePnpmWorkspace(pnpmYaml)
      : pkgGlobs.length > 0
        ? pkgGlobs
        : cargoIsWorkspace
          ? parseCargoMembers(rootCargo ?? '')
          : [];

  // Label precedence.
  if (pnpmYaml !== undefined) return { workspaceTool: 'pnpm', globs };
  if (hasTurbo) return { workspaceTool: 'turbo', globs };
  if (hasNx) return { workspaceTool: 'nx', globs };
  if (pkgGlobs.length > 0) {
    return { workspaceTool: disambiguateNodeTool(root, rootPkg), globs };
  }
  if (cargoIsWorkspace) return { workspaceTool: 'cargo', globs };

  // Directory-convention monorepo: no workspace config declared, but `apps/*` or
  // `packages/*` already hold members with their own manifests (e.g. boringstack's
  // independent-install apps). Treat it as a monorepo so the harness still proposes
  // cross-package guardrails. The label comes from `packageManager`/lockfile.
  const conventionGlobs = ['apps/*', 'packages/*'];
  if (resolvePackages(root, conventionGlobs, 'npm').length > 0) {
    return { workspaceTool: disambiguateNodeTool(root, rootPkg), globs: conventionGlobs };
  }

  // No workspace config and no member dirs: a lone package.json/Cargo.toml is
  // `single`; nothing is `unknown`.
  if (rootPkg !== undefined || rootCargo !== undefined) {
    return { workspaceTool: 'single', globs: [] };
  }
  return { workspaceTool: 'unknown', globs: [] };
}

/** The package manager named in a root `package.json` `packageManager` field
 *  (e.g. `"bun@1.3.14"` → `bun`), when it is one we model. */
function toolFromPackageManager(
  rootPkg: Record<string, unknown> | undefined,
): WorkspaceTool | undefined {
  const pm = rootPkg?.packageManager;
  if (typeof pm !== 'string') return undefined;
  const name = pm.split('@')[0]?.trim();
  if (name === 'pnpm' || name === 'bun' || name === 'yarn' || name === 'npm') {
    return name;
  }
  return undefined;
}

/** Disambiguate a node monorepo's tool: the explicit `packageManager` field wins,
 *  then the lockfile, defaulting to `npm`. */
function disambiguateNodeTool(
  root: string,
  rootPkg: Record<string, unknown> | undefined,
): WorkspaceTool {
  const declared = toolFromPackageManager(rootPkg);
  if (declared !== undefined) return declared;
  if (fileExists(path.join(root, 'bun.lockb')) || fileExists(path.join(root, 'bun.lock'))) {
    return 'bun';
  }
  if (fileExists(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fileExists(path.join(root, 'package-lock.json'))) return 'npm';
  return 'npm';
}

/** Resolve member globs into concrete packages. Supports exact dirs and simple
 *  `dir/*` (one-level) globs; ignores `!`-negations. Caps at {@link MAX_PACKAGES}. */
function resolvePackages(
  root: string,
  globs: string[],
  tool: WorkspaceTool,
): RepoPackage[] {
  const manifest = tool === 'cargo' ? 'Cargo.toml' : 'package.json';
  const seen = new Set<string>();
  const out: RepoPackage[] = [];

  const add = (dirAbs: string): void => {
    if (out.length >= MAX_PACKAGES) return;
    if (!fileExists(path.join(dirAbs, manifest))) return;
    const rel = toPosix(path.relative(root, dirAbs));
    if (rel.length === 0 || rel.startsWith('..') || seen.has(rel)) return;
    seen.add(rel);
    out.push(makePackage(root, rel, manifest));
  };

  for (const raw of globs) {
    const glob = raw.trim();
    if (glob.length === 0 || glob.startsWith('!')) continue;
    const star = glob.indexOf('*');
    if (star === -1) {
      add(path.resolve(root, glob));
      continue;
    }
    // `dir/*` (or `dir/**`): list the immediate subdirs of the prefix that carry
    // a manifest.
    const prefix = glob.slice(0, star).replace(/\/+$/, '');
    const baseAbs = path.resolve(root, prefix);
    for (const child of listDirs(baseAbs)) {
      add(path.join(baseAbs, child));
    }
  }
  return out;
}

/** Build one {@link RepoPackage} from a resolved member dir. */
function makePackage(
  root: string,
  rel: string,
  manifest: string,
): RepoPackage {
  const dirName = rel.split('/').pop() ?? rel;
  let name = dirName;
  if (manifest === 'package.json') {
    const pkg = readJson(path.join(root, rel, 'package.json'));
    const declared = typeof pkg?.name === 'string' ? pkg.name : undefined;
    if (declared !== undefined && declared.length > 0) name = declared;
  } else {
    const cargo = readText(path.join(root, rel, 'Cargo.toml'));
    const declared = cargo !== undefined ? cargoPackageName(cargo) : undefined;
    if (declared !== undefined && declared.length > 0) name = declared;
  }
  return { name, path: rel, role: roleForPath(rel) };
}

/** Classify a member by its path prefix. */
function roleForPath(rel: string): RepoPackage['role'] {
  if (rel.startsWith('apps/')) return 'app';
  if (rel.startsWith('packages/')) return 'package';
  if (rel.startsWith('tools/') || rel.startsWith('tooling/')) return 'tool';
  return 'unknown';
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

// ── parsing helpers (string-level; no YAML/TOML deps) ───────────────────────

/** Parse `packages:` entries out of a `pnpm-workspace.yaml`. */
function parsePnpmWorkspace(text: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      // A non-indented, non-list line ends the block.
      if (/^\S/.test(line) && !/^\s*-/.test(line)) break;
      const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line);
      if (m?.[1] !== undefined) globs.push(m[1].trim());
    }
  }
  return globs;
}

/** Parse a package.json `workspaces` field (array, or `{ packages: [] }`). */
function parsePkgWorkspaces(
  rootPkg: Record<string, unknown> | undefined,
): string[] {
  const ws = rootPkg?.workspaces;
  if (Array.isArray(ws)) return ws.filter((x): x is string => typeof x === 'string');
  if (ws !== null && typeof ws === 'object') {
    const pkgs = (ws as Record<string, unknown>).packages;
    if (Array.isArray(pkgs)) return pkgs.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

/** Parse `members = [ ... ]` out of a Cargo `[workspace]`. */
function parseCargoMembers(text: string): string[] {
  const block = /members\s*=\s*\[([\s\S]*?)\]/.exec(text);
  if (block?.[1] === undefined) return [];
  const out: string[] = [];
  const re = /['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1])) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/** Read the `name` of a Cargo `[package]`. */
function cargoPackageName(text: string): string | undefined {
  const m = /\[package\][\s\S]*?\bname\s*=\s*['"]([^'"]+)['"]/.exec(text);
  return m?.[1];
}

// ── fs primitives (all degrade-not-throw) ───────────────────────────────────

function readText(absPath: string): string | undefined {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return undefined;
  }
}

function readJson(absPath: string): Record<string, unknown> | undefined {
  const text = readText(absPath);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function fileExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

function dirExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/** Immediate subdirectory names of `absPath` (empty when unreadable). */
function listDirs(absPath: string): string[] {
  try {
    return fs
      .readdirSync(absPath, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Immediate file names of `absPath` (empty when unreadable). */
function listFiles(absPath: string): string[] {
  try {
    return fs
      .readdirSync(absPath, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Normalize an OS path to forward slashes (so generated/contract paths match). */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
