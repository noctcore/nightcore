// @ts-check
import { isGrandfathered, loadBaseline } from '../baseline';
import type { IMetaCtx, IMetaRule, IViolation } from '../types';

/**
 * `web-file-size-ratchet` — file-size governance for apps/web (issue #50).
 *
 * Nothing else caps web file size, and the escape hatch is proven:
 * `max-hooks-per-file` counts only EXPORTED hooks, so a 1,300-line mega-hook
 * file passes a rule whose stated intent is "doing too much; split it".
 *
 * Two caps, deliberately split — do NOT "fix" one without the other:
 *
 *  - **400 lines (this rule, ciCritical)** — the ratchet. Today's offenders are
 *    frozen in `baselines/web-file-size-ratchet.json` (the shared ratchet infra
 *    from issue #17 — see `baseline.ts`). A NEW over-cap file, or a frozen one
 *    that GREW, fails. Legacy files may only shrink; new files may never join.
 *  - **500 lines (ESLint core `max-lines` in `eslint.config.mjs`)** — blunt
 *    in-editor feedback while typing, with a freeze-at-worst carve-out block
 *    for the current offenders (severity stays `error`; `no-warn-severity` is
 *    ciCritical, so `'warn'` may never appear).
 *
 * Measured in raw physical lines (`wc -l` semantics) so the number an author
 * sees in the editor is the number the gate sees. Excluded: `.test.` /
 * `.stories.` files, `__screenshots__`, and `lib/generated/**` (ts-rs codegen).
 *
 * The baseline additionally SELF-TIGHTENS: an entry whose file is gone, is now
 * at/below the cap, or shrank >=15% below its frozen value is itself a
 * violation demanding `bun run lint:meta -- --update-baseline` — so paydowns
 * are captured and the frozen debt can only shrink.
 */

const CAP = 400;
const WEB_SRC = 'apps/web/src';
/** An entry whose file shrank >=15% below its frozen value must be tightened. */
const TIGHTEN_RATIO = 0.85;

/** Raw physical lines, `wc -l` semantics (a trailing newline adds no line). */
export function countLines(text: string): number {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function webSourceFiles(ctx: IMetaCtx): string[] {
  // Bun's Glob has no `{ts,tsx}` brace alternation — glob each extension
  // separately and merge.
  return [`${WEB_SRC}/**/*.ts`, `${WEB_SRC}/**/*.tsx`]
    .flatMap((pattern) => ctx.glob(pattern))
    .filter(
      (rel) =>
        !rel.includes('.test.') &&
        !rel.includes('.stories.') &&
        !rel.includes('__screenshots__') &&
        !rel.startsWith(`${WEB_SRC}/lib/generated/`),
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
  for (const file of webSourceFiles(ctx)) {
    const text = ctx.read(file);
    if (text === null) continue;
    const n = countLines(text);
    if (n > CAP) map[file] = n;
  }
  return map;
}

export const webFileSizeRatchetRule: IMetaRule = {
  id: 'web-file-size-ratchet',
  category: 'source-text',
  ciCritical: true,
  description:
    "apps/web source files stay at or under 400 raw lines (tests/stories/codegen excluded). Today's offenders are grandfathered by baselines/web-file-size-ratchet.json; a new/grown offender fails, and a stale/shrunk baseline entry demands tightening.",
  baseline(ctx) {
    return currentOffenders(ctx);
  },
  run(ctx) {
    const baseline = loadBaseline(ctx, 'web-file-size-ratchet');
    const violations: IViolation[] = [];

    // Over-cap files: grandfathered while within their frozen line count.
    for (const [file, n] of Object.entries(currentOffenders(ctx))) {
      if (isGrandfathered(baseline, file, n)) {
        console.error(
          `[grandfathered] web-file-size-ratchet (${file}): ${n} lines frozen by baseline (cap ${CAP}) — split to ratchet down.`,
        );
      } else {
        violations.push({
          file,
          rule: 'web-file-size-ratchet',
          message: `file exceeds the ${CAP}-line cap: ${n} lines. New files never join the baseline and frozen files may not grow — split it (companion in-editor cap: ESLint core max-lines at 500).`,
        });
      }
    }

    // Self-tightening: stale or over-generous baseline entries are violations.
    for (const [file, frozen] of Object.entries(baseline)) {
      const text = ctx.read(file);
      if (text === null) {
        violations.push({
          file,
          rule: 'web-file-size-ratchet',
          message: `baseline entry is stale — the file no longer exists. Remove it: bun run lint:meta -- --update-baseline.`,
        });
        continue;
      }
      const n = countLines(text);
      if (n <= CAP) {
        violations.push({
          file,
          rule: 'web-file-size-ratchet',
          message: `baseline entry is stale — the file is now within the ${CAP}-line cap (${n} lines). Remove it: bun run lint:meta -- --update-baseline.`,
        });
      } else if (n < frozen * TIGHTEN_RATIO) {
        violations.push({
          file,
          rule: 'web-file-size-ratchet',
          message: `baseline entry is over-generous — the file shrank >=15% below its frozen ${frozen} (now ${n} lines). Tighten it: bun run lint:meta -- --update-baseline.`,
        });
      }
    }

    return violations;
  },
};
