// @ts-check
import { isGrandfathered, loadBaseline } from '../baseline';
import type { IMetaCtx, IMetaRule, IViolation } from '../types';
import { countLines } from './web-file-size-ratchet';

/**
 * `engine-file-size-ratchet` — file-size governance for packages/engine (issue #232).
 *
 * `web-file-size-ratchet` globs only `apps/web/src` and `rust-module-shape`
 * only `apps/desktop/src-tauri/src`, so `packages/engine/src` — where the
 * heaviest logic files live — matched no cap at all. This rule closes that gap
 * with the same 400-line ratchet the web rule uses.
 *
 * Today's offenders are frozen in `baselines/engine-file-size-ratchet.json`
 * (the shared ratchet infra from issue #17 — see `baseline.ts`). A NEW over-cap
 * file, or a frozen one that GREW, fails; legacy files may only shrink and new
 * files may never join. The ratchet does not force a refactor now — it prevents
 * the debt from growing.
 *
 * Measured in raw physical lines (`wc -l` semantics, via `countLines` shared
 * with the web rule) so the number an author sees in the editor is the number
 * the gate sees. Excluded: `.test.` / `.spec.` / `.stories.` files.
 *
 * The baseline additionally SELF-TIGHTENS: an entry whose file is gone, is now
 * at/below the cap, or shrank >=15% below its frozen value is itself a
 * violation demanding `bun run lint:meta -- --update-baseline` — so paydowns
 * are captured and the frozen debt can only shrink.
 */

const CAP = 400; // cross-ref: web-file-size-ratchet.ts + rust-module-shape.ts (HARD_CAP) share the 400 cap
const ENGINE_SRC = 'packages/engine/src';
/** An entry whose file shrank >=15% below its frozen value must be tightened. */
const TIGHTEN_RATIO = 0.85;

function engineSourceFiles(ctx: IMetaCtx): string[] {
  // Bun's Glob has no `{ts,tsx}` brace alternation; engine is pure `.ts` anyway.
  return ctx
    .glob(`${ENGINE_SRC}/**/*.ts`)
    .filter(
      (rel) =>
        !rel.includes('.test.') &&
        !rel.includes('.spec.') &&
        !rel.includes('.stories.'),
    )
    .sort();
}

/**
 * The current offender map (`<repo-rel> → lines` for every file over the cap).
 * Shared by `run` (what to grandfather) and `baseline` (what to freeze) so the
 * two can never disagree.
 */
function currentOffenders(ctx: IMetaCtx): Record<string, number> {
  const map: Record<string, number> = {};
  for (const file of engineSourceFiles(ctx)) {
    const text = ctx.read(file);
    if (text === null) continue;
    const n = countLines(text);
    if (n > CAP) map[file] = n;
  }
  return map;
}

export const engineFileSizeRatchetRule: IMetaRule = {
  id: 'engine-file-size-ratchet',
  category: 'source-text',
  ciCritical: true,
  description:
    "packages/engine source files stay at or under 400 raw lines (tests/specs/stories excluded). Today's offenders are grandfathered by baselines/engine-file-size-ratchet.json; a new/grown offender fails, and a stale/shrunk baseline entry demands tightening.",
  baseline(ctx) {
    return currentOffenders(ctx);
  },
  run(ctx) {
    const baseline = loadBaseline(ctx, 'engine-file-size-ratchet');
    const violations: IViolation[] = [];

    // Over-cap files: grandfathered while within their frozen line count.
    for (const [file, n] of Object.entries(currentOffenders(ctx))) {
      if (isGrandfathered(baseline, file, n)) {
        console.error(
          `[grandfathered] engine-file-size-ratchet (${file}): ${n} lines frozen by baseline (cap ${CAP}) — split to ratchet down.`,
        );
      } else {
        violations.push({
          file,
          rule: 'engine-file-size-ratchet',
          message: `file exceeds the ${CAP}-line cap: ${n} lines. New files never join the baseline and frozen files may not grow — split it.`,
        });
      }
    }

    // Self-tightening: stale or over-generous baseline entries are violations.
    for (const [file, frozen] of Object.entries(baseline)) {
      const text = ctx.read(file);
      if (text === null) {
        violations.push({
          file,
          rule: 'engine-file-size-ratchet',
          message: `baseline entry is stale — the file no longer exists. Remove it: bun run lint:meta -- --update-baseline.`,
        });
        continue;
      }
      const n = countLines(text);
      if (n <= CAP) {
        violations.push({
          file,
          rule: 'engine-file-size-ratchet',
          message: `baseline entry is stale — the file is now within the ${CAP}-line cap (${n} lines). Remove it: bun run lint:meta -- --update-baseline.`,
        });
      } else if (n < frozen * TIGHTEN_RATIO) {
        violations.push({
          file,
          rule: 'engine-file-size-ratchet',
          message: `baseline entry is over-generous — the file shrank >=15% below its frozen ${frozen} (now ${n} lines). Tighten it: bun run lint:meta -- --update-baseline.`,
        });
      }
    }

    return violations;
  },
};
