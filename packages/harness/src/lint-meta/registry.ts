/**
 * Bounded-eval registry loading (§5 supply-chain posture). The lint-meta
 * subcommand imports EXACTLY ONE file — the enumerated rule registry at a fixed
 * path — and runs the rules it exports. It NEVER scan-and-imports arbitrary `.js`:
 * the eval surface is precisely the declared registry, so a stray `.js` dropped
 * beside it is never loaded.
 *
 * A registry is any module that exports its rules as an array under `META_RULES`
 * (the contract the synthesis reference documents) — as a named export, or as the
 * module's default (the CJS `module.exports = { META_RULES }` interop shape). The
 * loader is pure over an injected {@link ModuleImporter} so the boundedness is
 * unit-testable without touching the real module loader.
 *
 * ## TypeScript registries (#325)
 * Generated `lint-meta-rule` artifacts are TypeScript, and Nightcore's portable-lock
 * exporter is deterministic Rust that never shells out to a transpiler — so it copies
 * the rules VERBATIM and emits a `.ts` registry. The transpile therefore lives HERE, in
 * the published runner: Node's own type stripping (unflagged since 22.18) loads a `.ts`
 * module directly, which keeps this package at ZERO runtime dependencies (a bundled
 * stripper would be the first one). Nothing extra is needed to load a `.ts` file — but
 * the three ways it can fail are opaque, so {@link describeImportError} translates them
 * into the fix.
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { IMetaRule } from './types.js';

/**
 * The fixed, repo-relative registry paths the runner tries, in order, when no
 * `--registry` is given. The `.ts` form (what the portable-lock exporter emits) wins
 * over a legacy `.js` one so an exported bundle is authoritative in a repo that still
 * carries a hand-rolled JavaScript registry. Still BOUNDED eval: a fixed, enumerated
 * two-entry list, of which exactly one file is ever imported.
 */
export const DEFAULT_REGISTRY_RELATIVE_PATHS = [
  '.nightcore/lint-meta/registry.ts',
  '.nightcore/lint-meta/registry.js',
] as const;

/** Imports the module at an ABSOLUTE path. Real or faked (bounded-eval tests). */
export type ModuleImporter = (absPath: string) => Promise<unknown>;

/** The real dynamic import, addressed by file URL so an absolute path resolves. */
export const defaultImporter: ModuleImporter = (absPath) =>
  import(pathToFileURL(absPath).href);

/** The result of loading a registry: its rules, or a human-readable `error`. */
export interface LoadedRegistry {
  rules: IMetaRule[];
  error?: string;
}

/** A structurally rule-shaped object: an `id` string and a `run` function. */
function isMetaRule(v: unknown): v is IMetaRule {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.run === 'function';
}

/** The first `META_RULES`/default export that is an array of rule-shaped objects. */
function extractRules(mod: unknown): IMetaRule[] | null {
  if (typeof mod !== 'object' || mod === null) return null;
  const m = mod as Record<string, unknown>;
  const def = m.default as Record<string, unknown> | undefined;
  const candidates: unknown[] = [
    m.META_RULES,
    def?.META_RULES,
    m.default,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.every(isMetaRule)) return candidate;
  }
  return null;
}

/** Whether a path names a TypeScript module (`.ts` / `.mts` / `.cts`). */
function isTypeScript(absPath: string): boolean {
  return /\.[cm]?ts$/.test(absPath);
}

/**
 * Turn an import failure into a message that names the FIX. The three ways a
 * TypeScript registry fails are all opaque out of the box:
 *  - `ERR_UNKNOWN_FILE_EXTENSION` — the Node running the runner predates unflagged
 *    type stripping (< 22.18), so it cannot load `.ts` at all.
 *  - `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` — the registry was committed under
 *    a `node_modules/`, where Node refuses to strip types.
 *  - `Cannot use import statement outside a module` — the registry is ESM but its
 *    nearest `package.json` says CommonJS (the exported bundle ships a `package.json`
 *    with `{"type":"module"}` beside the registry precisely to prevent this).
 */
function describeImportError(absRegistryPath: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!isTypeScript(absRegistryPath)) return message;
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;

  if (code === 'ERR_UNKNOWN_FILE_EXTENSION' || message.includes('Unknown file extension')) {
    return `${message} — this Node cannot load a TypeScript registry. Node >= 22.18 strips types natively (${process.version} is running); upgrade Node, or point --registry at a JavaScript registry.`;
  }
  if (code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING') {
    return `${message} — Node refuses to strip types under node_modules/; commit the registry in the repo itself.`;
  }
  if (message.includes('Cannot use import statement outside a module')) {
    return `${message} — the registry is an ES module but the nearest package.json is CommonJS. Commit a package.json containing {"type":"module"} beside the registry (an exported Nightcore bundle ships one).`;
  }
  return message;
}

/**
 * Load the rule registry at `absRegistryPath` through `importer` (bounded eval:
 * importer is called with THIS path and no other). Returns the exported rules, or
 * an `error` string when the import throws or the module exposes no valid
 * `META_RULES` array — a malformed registry reds the build (fail-safe), it never
 * silently enforces nothing.
 */
export async function loadRegistry(
  absRegistryPath: string,
  importer: ModuleImporter = defaultImporter,
): Promise<LoadedRegistry> {
  let mod: unknown;
  try {
    mod = await importer(absRegistryPath);
  } catch (err) {
    return { rules: [], error: describeImportError(absRegistryPath, err) };
  }
  const rules = extractRules(mod);
  if (rules === null) {
    return {
      rules: [],
      error:
        'the registry must export `META_RULES` (a named export, or the default) ' +
        'as an array of { id, run } rule objects',
    };
  }
  return { rules };
}
