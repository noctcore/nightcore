// @ts-check
import type { IMetaRule, IViolation } from '../types';

/**
 * Package-shape invariant. Every workspace is named `@nightcore/<dir>` matching
 * its folder. Library packages (packages/*) additionally expose a single
 * `src/index.ts` barrel and point `main`/`module`/`types`/`exports` at `./dist/`.
 * apps/* are deployable surfaces (vite/tauri/bun entrypoints) — only the name
 * match applies to them, not the dist/barrel build-output checks.
 */
function dirOf(rel: string): string {
  return rel.replace(/\/package\.json$/, '');
}
function baseName(dir: string): string {
  const parts = dir.split('/');
  return parts[parts.length - 1];
}

export const packageShapeRule: IMetaRule = {
  id: 'package-shape',
  category: 'config',
  ciCritical: true,
  description:
    'Every workspace is named @nightcore/<dir>; library packages expose src/index.ts and point main/module/types/exports at ./dist/.',
  run(ctx) {
    const violations: IViolation[] = [];
    const pkgJsons = [
      ...ctx.glob('packages/*/package.json'),
      ...ctx.glob('apps/*/package.json'),
    ];
    for (const rel of pkgJsons) {
      const raw = ctx.read(rel);
      if (raw === null) continue;
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        violations.push({ file: rel, rule: 'package-shape', message: 'package.json is not valid JSON.' });
        continue;
      }
      const dir = dirOf(rel);
      const expected = `@nightcore/${baseName(dir)}`;
      if (pkg.name !== expected) {
        violations.push({
          file: rel,
          rule: 'package-shape',
          message: `Workspace name '${String(pkg.name)}' must equal '${expected}' (the directory it lives in).`,
        });
      }
      // Build-output checks apply only to library packages.
      if (!rel.startsWith('packages/')) continue;
      if (!ctx.exists(`${dir}/src/index.ts`)) {
        violations.push({
          file: rel,
          rule: 'package-shape',
          message: `Library package must expose a single barrel at ${dir}/src/index.ts.`,
        });
      }
      for (const field of ['main', 'module', 'types'] as const) {
        const val = pkg[field];
        if (typeof val === 'string' && !val.includes('dist/')) {
          violations.push({
            file: rel,
            rule: 'package-shape',
            message: `package.json "${field}" ('${val}') must point at the built output under ./dist/.`,
          });
        }
      }
      if (pkg.exports && !JSON.stringify(pkg.exports).includes('dist/')) {
        violations.push({
          file: rel,
          rule: 'package-shape',
          message: 'package.json "exports" must reference the built output under ./dist/.',
        });
      }
    }
    return violations;
  },
};
