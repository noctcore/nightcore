/**
 * Workspace-tool detection + member-package resolution for the Harness repo
 * profiler. Given a repo root (plus its parsed root `package.json`/`Cargo.toml`),
 * decides which monorepo tool (if any) is in play and resolves the concrete
 * member packages its globs point at. Pure synchronous fs reads via
 * `fs-probe.ts`; never throws — see that module's doc comment for the
 * degrade-not-throw discipline this mirrors.
 */
import * as path from 'node:path';

import type { RepoPackage, WorkspaceTool } from '@nightcore/contracts';

import { fileExists, listDirs, readJson, readText, toPosix } from './fs-probe.js';

/** Cap on discovered workspace members — keeps a pathological glob from listing
 *  thousands of dirs. */
const MAX_PACKAGES = 50;

/** Decide the workspace tool + the package globs to resolve members from. The
 *  tool label follows a fixed precedence (pnpm → turbo → nx → package.json
 *  `workspaces` → cargo); the globs come from whichever source actually lists
 *  members. */
export function detectWorkspace(
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
export function resolvePackages(
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
