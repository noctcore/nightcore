// @ts-check
import type { IMetaRule, IViolation } from '../types';

/**
 * Pure helpers must live in one canonical `.utils.ts` home. When the .utils
 * pattern is adopted, duplicate exported helper names (same symbol exported
 * from 2+ different .utils.ts files) are flagged. Scope starts narrow
 * (apps/web/src non-lib files). Strict, no baseline.
 */
const WEB_SRC = 'apps/web/src';
const UTILS_GLOB = `${WEB_SRC}/**/*.utils.ts`;

// Extract top-level exported identifiers (functions, consts, and re-exports).
const EXPORT_DECL_RE =
  /\bexport\s+(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const EXPORT_LIST_RE = /\bexport\s*\{\s*([^}]+?)\s*\}/g;

function extractExportedNames(content: string): string[] {
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  EXPORT_DECL_RE.lastIndex = 0;
  while ((m = EXPORT_DECL_RE.exec(content)) !== null) {
    names.add(m[1]);
  }
  EXPORT_LIST_RE.lastIndex = 0;
  while ((m = EXPORT_LIST_RE.exec(content)) !== null) {
    const list = m[1];
    for (const part of list.split(',')) {
      const ident = part.trim().split(/\s+as\s+/i)[0].trim();
      if (/^[A-Za-z_$]/.test(ident)) names.add(ident);
    }
  }
  return Array.from(names);
}

export const canonicalHelpersSingleHomeRule: IMetaRule = {
  id: 'canonical-helpers-single-home',
  category: 'source-text',
  ciCritical: true,
  description:
    'Pure helpers must live in one canonical .utils.ts home (flag duplicates when pattern adopted).',
  run(ctx) {
    const violations: IViolation[] = [];
    const files = ctx
      .glob(UTILS_GLOB)
      .filter((f) => !f.includes('/lib/'));
    const nameToHomes: Record<string, string[]> = {};
    for (const file of files) {
      const content = ctx.read(file) ?? '';
      for (const name of extractExportedNames(content)) {
        (nameToHomes[name] ??= []).push(file);
      }
    }
    for (const [name, homes] of Object.entries(nameToHomes)) {
      if (homes.length > 1) {
        violations.push({
          file: homes[0],
          rule: 'canonical-helpers-single-home',
          message: `Helper '${name}' lives in multiple .utils.ts homes (${homes.join(', ')}) — consolidate to the canonical one.`,
        });
      }
    }
    return violations;
  },
};
