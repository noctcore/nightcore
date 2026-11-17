import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { IMetaCtx, IMetaRule, IViolation } from '../lint-meta/types.js';
import { workspaceList, workspaceScalar } from './pnpm-workspace-yaml.js';

export const ONLY_BUILT_DEPENDENCIES_HAVE_SCRIPTS_ID = 'only-built-dependencies-have-scripts';
const STORE = path.join('node_modules', '.pnpm');
const LISTS = ['onlyBuiltDependencies', 'ignoredBuiltDependencies'] as const;
type ListName = (typeof LISTS)[number];
/** Build settings this rule does not read: one of them in use would decide builds behind its back. */
const UNREAD = ['allowBuilds', 'neverBuiltDependencies', 'onlyBuiltDependenciesFile'] as const;
const LIFECYCLE = ['preinstall', 'install', 'postinstall'] as const;

/**
 * The two pnpm build-script lists name exactly the installed packages that have
 * a build step, each once.
 *
 * With `strictDepBuilds` on, an install fails when a package with a build step
 * is in neither list, so that half guards itself. The other half does not: a
 * name that stays in `onlyBuiltDependencies` after its package dropped its
 * script (or left the tree) is a standing permission for whatever script a
 * later version of it ships, and nothing ever says so. This rule reads what is
 * installed (`node_modules/.pnpm`) and reports:
 *
 *   1. a listed name that is not installed, or none of whose installed
 *      versions has a build step
 *   2. a name in both lists
 *   3. an installed package with a build step in neither list (strictDepBuilds
 *      fails the install for it; this says which one, and catches a tree that
 *      was installed before the setting)
 *   4. a build setting this rule does not read (`allowBuilds`,
 *      `neverBuiltDependencies`, `onlyBuiltDependenciesFile`), and a tree with
 *      nothing installed: neither is a pass
 *
 * A build step is what pnpm counts (`pkgRequiresBuild`): a preinstall, install
 * or postinstall script, a `binding.gyp` (pnpm then runs `node-gyp rebuild`) or
 * files under `.hooks/`. The lists are read from the root package.json's `pnpm`
 * block and from pnpm-workspace.yaml. A platform package installed only on
 * another OS is not in this machine's store, so a listed one reads as not
 * installed here: keep such packages out of the lists.
 */

interface IInstalled {
  readonly name: string;
  readonly version: string;
  /** What makes it a build: the lifecycle script names, `binding.gyp` or `.hooks/`; empty when nothing does. */
  readonly buildSteps: readonly string[];
}

function violation(file: string, message: string): IViolation {
  return { file, rule: ONLY_BUILT_DEPENDENCIES_HAVE_SCRIPTS_ID, message };
}

/** A list entry's package name: `nx@21.6.4 || 21.6.5` names `nx`. */
function entryName(entry: string): string {
  const at = entry.indexOf('@', 1);
  return at === -1 ? entry.trim() : entry.slice(0, at).trim();
}

function readInstalled(dir: string): IInstalled | null {
  const manifestPath = path.join(dir, 'package.json');
  if (!existsSync(manifestPath)) return null;
  let manifest: { name?: string; version?: string; scripts?: Record<string, string> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest;
  } catch {
    return null;
  }
  if (manifest.name === undefined) return null;
  const buildSteps: string[] = LIFECYCLE.filter((stage) => Boolean(manifest.scripts?.[stage]));
  if (existsSync(path.join(dir, 'binding.gyp'))) buildSteps.push('binding.gyp');
  if (existsSync(path.join(dir, '.hooks'))) buildSteps.push('.hooks/');
  return { name: manifest.name, version: manifest.version ?? '?', buildSteps };
}

/** Every package in pnpm's virtual store, or null when there is no store. Dependencies are symlinks there; the package itself is the one real directory. */
export function installedPackages(root: string): IInstalled[] | null {
  const store = path.join(root, STORE);
  if (!existsSync(store)) return null;
  const found: IInstalled[] = [];
  for (const entry of readdirSync(store)) {
    const modules = path.join(store, entry, 'node_modules');
    if (entry === 'node_modules' || !existsSync(modules)) continue;
    for (const child of readdirSync(modules)) {
      const candidates = child.startsWith('@')
        ? readdirSync(path.join(modules, child)).map((name) => path.join(modules, child, name))
        : [path.join(modules, child)];
      for (const candidate of candidates) {
        if (!lstatSync(candidate).isDirectory()) continue;
        const installed = readInstalled(candidate);
        if (installed !== null) found.push(installed);
      }
    }
  }
  return found;
}

function declaredLists(ctx: IMetaCtx): {
  lists: Map<ListName, string[]>;
  problems: IViolation[];
} {
  const lists = new Map<ListName, string[]>(LISTS.map((list) => [list, []]));
  const problems: IViolation[] = [];
  let pnpmBlock: Record<string, unknown> = {};
  try {
    pnpmBlock =
      (JSON.parse(ctx.read('package.json') ?? '{}') as { pnpm?: Record<string, unknown> }).pnpm ??
      {};
  } catch {
    problems.push(
      violation(
        'package.json',
        'package.json is not valid JSON, so its build-script lists cannot be read.',
      ),
    );
  }
  const workspace = ctx.read('pnpm-workspace.yaml') ?? '';
  for (const list of LISTS) {
    const fromManifest = pnpmBlock[list];
    if (Array.isArray(fromManifest)) {
      lists.get(list)?.push(...fromManifest.map((entry) => entryName(String(entry))));
    }
    const fromWorkspace = workspaceList(workspace, list);
    for (const line of fromWorkspace?.unreadable ?? []) {
      problems.push(
        violation(
          'pnpm-workspace.yaml',
          `\`${list}\` holds "${line}", which this rule cannot read. Write one \`- name\` entry per line.`,
        ),
      );
    }
    lists.get(list)?.push(...(fromWorkspace?.items ?? []).map((item) => entryName(item.value)));
  }
  for (const key of UNREAD) {
    if (key in pnpmBlock || workspaceScalar(workspace, key) !== null) {
      problems.push(
        violation(
          key in pnpmBlock ? 'package.json' : 'pnpm-workspace.yaml',
          `\`${key}\` is set. This rule reads only onlyBuiltDependencies and ignoredBuiltDependencies; moving to another build setting means moving this rule with it.`,
        ),
      );
    }
  }
  return { lists, problems };
}

/** The pnpm build-script lists name exactly the installed packages that have a build step. */
export function createOnlyBuiltDependenciesHaveScriptsRule(): IMetaRule {
  return {
    id: ONLY_BUILT_DEPENDENCIES_HAVE_SCRIPTS_ID,
    category: 'supply-chain',
    ciCritical: true,
    description:
      'onlyBuiltDependencies and ignoredBuiltDependencies name exactly the installed packages that have a build step (an install script, binding.gyp or .hooks/), each in one list: no stale permission for a package without a script, none missing.',
    run(ctx: IMetaCtx): IViolation[] {
      const { lists, problems } = declaredLists(ctx);
      const installed = installedPackages(ctx.root);
      if (installed === null) {
        return [
          ...problems,
          violation(
            'package.json',
            'node_modules/.pnpm does not exist, so which packages have a build step cannot be checked. Run `pnpm install`.',
          ),
        ];
      }

      const only = lists.get('onlyBuiltDependencies') ?? [];
      const ignored = lists.get('ignoredBuiltDependencies') ?? [];
      for (const name of only.filter((entry) => ignored.includes(entry))) {
        problems.push(
          violation(
            'package.json',
            `"${name}" is in both onlyBuiltDependencies and ignoredBuiltDependencies. Decide: its script runs, or it never does.`,
          ),
        );
      }
      for (const list of LISTS) {
        for (const name of lists.get(list) ?? []) {
          const versions = installed.filter((pkg) => pkg.name === name);
          if (versions.length === 0) {
            problems.push(
              violation('package.json', `"${name}" is in ${list} but is not installed. Remove the entry.`),
            );
          } else if (versions.every((pkg) => pkg.buildSteps.length === 0)) {
            problems.push(
              violation(
                'package.json',
                `"${name}" is in ${list} but no installed version has a preinstall, install or postinstall script, a binding.gyp or .hooks/ (${versions.map((pkg) => pkg.version).join(', ')}). Remove the entry: it would let a script a later version adds run unreviewed.`,
              ),
            );
          }
        }
      }
      const listed = new Set([...only, ...ignored]);
      const unlisted = installed
        .filter((pkg) => pkg.buildSteps.length > 0 && !listed.has(pkg.name))
        .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
      for (const pkg of unlisted) {
        problems.push(
          violation(
            'package.json',
            `"${pkg.name}" (${pkg.version}) has a build step (${pkg.buildSteps.join(', ')}) but is in neither onlyBuiltDependencies nor ignoredBuiltDependencies. Read the script, then file it under one of them.`,
          ),
        );
      }
      return problems;
    },
  };
}
