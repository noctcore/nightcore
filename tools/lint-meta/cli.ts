// @ts-check
/**
 * lint-meta CLI entry point. Builds the filesystem/exec context rooted at the
 * repo, runs every registered meta rule, prints each violation, and exits
 * non-zero when any `ciCritical` rule reports one (or a rule throws).
 *
 * `--json` selects a machine-readable reporter instead (opt-in; the text reporter
 * stays the default so `bun run lint:meta` and CI are unchanged) — see
 * `json-reporter.ts` for the stable output contract.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Glob } from 'bun';

import { serializeBaseline } from './baseline';
import { buildJsonReport, type RuleOutcome } from './json-reporter';
import { normalizeText, toPosixRel } from './paths';
import { META_RULES } from './registry';
import type { IMetaCtx, IMetaRule } from './types';

// cli.ts lives at tools/lint-meta/cli.ts → repo root is two levels up.
const ROOT = path.resolve(import.meta.dir, '..', '..');

const ctx: IMetaCtx = {
  root: ROOT,
  read(rel) {
    const abs = path.join(ROOT, toPosixRel(rel));
    if (!existsSync(abs)) return null;
    return normalizeText(readFileSync(abs, 'utf8'));
  },
  exists(rel) {
    return existsSync(path.join(ROOT, toPosixRel(rel)));
  },
  glob(pattern) {
    return Array.from(new Glob(pattern).scanSync({ cwd: ROOT })).map(toPosixRel);
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

// `--update-baseline`: regenerate every ratcheting rule's committed baseline from
// the current tree, then exit. Run after a legitimate paydown (a god-file split)
// to lower the frozen debt — never to raise it past a real regression.
if (process.argv.includes('--update-baseline')) {
  const dir = path.join(ROOT, 'tools/lint-meta/baselines');
  mkdirSync(dir, { recursive: true });
  for (const rule of META_RULES) {
    if (!rule.baseline) continue;
    const map = rule.baseline(ctx);
    const file = path.join(dir, `${rule.id}.json`);
    writeFileSync(file, serializeBaseline(map));
    console.log(
      `updated baseline: tools/lint-meta/baselines/${rule.id}.json (${Object.keys(map).length} entries)`,
    );
  }
  process.exit(0);
}

// Run every rule once, capturing a throw as an outcome (never aborting the run) so
// the text reporter and the `--json` reporter fold over the exact same results.
const outcomes: Array<{ rule: IMetaRule; outcome: RuleOutcome }> = [];
for (const rule of META_RULES) {
  try {
    outcomes.push({
      rule,
      outcome: { id: rule.id, violations: rule.run(ctx), error: null },
    });
  } catch (err) {
    outcomes.push({
      rule,
      outcome: { id: rule.id, violations: [], error: String(err) },
    });
  }
}

// `--json`: emit the machine-readable report and exit 0 (like `--update-baseline`).
// The payload — not the exit code — carries pass/fail, so a consumer (Drift v1
// EnforceRun) parses stdout without a violation surfacing as a process failure.
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(buildJsonReport(outcomes.map((o) => o.outcome)), null, 2));
  process.exit(0);
}

// Default: the human/CI text reporter — unchanged.
let criticalCount = 0;
let totalCount = 0;

for (const { rule, outcome } of outcomes) {
  if (outcome.error !== null) {
    console.error(`[ERROR] ${rule.id}: rule threw — ${outcome.error}`);
    criticalCount += rule.ciCritical ? 1 : 0;
    continue;
  }
  for (const v of outcome.violations) {
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
