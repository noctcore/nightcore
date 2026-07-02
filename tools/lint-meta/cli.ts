// @ts-check
/**
 * lint-meta CLI entry point. Builds the filesystem/exec context rooted at the
 * repo, runs every registered meta rule, prints each violation, and exits
 * non-zero when any `ciCritical` rule reports one (or a rule throws).
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Glob } from 'bun';

import { META_RULES } from './registry';
import type { IMetaCtx } from './types';

// cli.ts lives at tools/lint-meta/cli.ts → repo root is two levels up.
const ROOT = path.resolve(import.meta.dir, '..', '..');

const ctx: IMetaCtx = {
  root: ROOT,
  read(rel) {
    const abs = path.join(ROOT, rel);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  },
  exists(rel) {
    return existsSync(path.join(ROOT, rel));
  },
  glob(pattern) {
    return Array.from(new Glob(pattern).scanSync({ cwd: ROOT }));
  },
  exec(cmd) {
    try {
      const stdout = execSync(cmd, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  },
};

let criticalCount = 0;
let totalCount = 0;

for (const rule of META_RULES) {
  let violations;
  try {
    violations = rule.run(ctx);
  } catch (err) {
    console.error(`[ERROR] ${rule.id}: rule threw — ${String(err)}`);
    criticalCount += rule.ciCritical ? 1 : 0;
    continue;
  }
  for (const v of violations) {
    totalCount += 1;
    const tag = rule.ciCritical ? 'ERROR' : 'info';
    console.error(`[${tag}] ${v.rule} (${v.file}): ${v.message}`);
    if (rule.ciCritical) criticalCount += 1;
  }
}

if (totalCount === 0) {
  console.log('lint-meta: no violations');
}

process.exit(criticalCount > 0 ? 1 : 0);
