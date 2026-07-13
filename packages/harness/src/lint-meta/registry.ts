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
 */
import { pathToFileURL } from 'node:url';

import type { IMetaRule } from './types.js';

/** The fixed, repo-relative path the runner loads the rule registry from. */
export const DEFAULT_REGISTRY_RELATIVE_PATH = '.nightcore/lint-meta/registry.js';

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
    return { rules: [], error: err instanceof Error ? err.message : String(err) };
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
