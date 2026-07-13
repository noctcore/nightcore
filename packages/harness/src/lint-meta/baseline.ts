/**
 * The generic lint-meta ratchet — a faithful port of `tools/lint-meta/baseline.ts`.
 *
 * A baseline is a committed `<baselineDir>/<rule-id>.json` — a flat `key → number`
 * map freezing today's offenders at their current metric. The ratchet is one-way:
 * an offender that is recorded AND has not grown past its frozen value is
 * grandfathered (suppressed); a NEW offender, or a recorded one that GREW, is a
 * live violation. As each offender is fixed, its entry is deleted (or lowered),
 * never raised — the frozen debt only shrinks.
 *
 * The `key` is opaque to this module: a rule with more than one metric family
 * namespaces its keys (`size:<file>`, `manifest:<file>`) so one flat map serves both.
 *
 * The only portability change from the internal engine is the baseline HOME: the
 * Nightcore engine hardcodes `tools/lint-meta/baselines/`, whereas a portable rule
 * ships its baselines under {@link DEFAULT_BASELINE_DIR} (overridable per call).
 */
import type { IMetaCtx } from './types.js';

/** Where a portable rule's committed baselines live, relative to the repo root. */
export const DEFAULT_BASELINE_DIR = '.nightcore/lint-meta/baselines';

/** Load a rule's committed baseline, or `{}` when none exists yet. */
export function loadBaseline(
  ctx: IMetaCtx,
  ruleId: string,
  baselineDir: string = DEFAULT_BASELINE_DIR,
): Record<string, number> {
  const raw = ctx.read(`${baselineDir}/${ruleId}.json`);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isNumberMap(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Whether `current` for `key` is grandfathered by `baseline`: recorded AND not
 * grown past the frozen value. A key absent from the baseline is never
 * grandfathered (a new offender always fails); a recorded key whose current value
 * is `<=` its record passes (the ratchet permits staying same-or-shrinking).
 */
export function isGrandfathered(
  baseline: Record<string, number>,
  key: string,
  current: number,
): boolean {
  const frozen = baseline[key];
  return frozen !== undefined && current <= frozen;
}

/** Serialize a baseline map with sorted keys for a stable, diff-friendly file. */
export function serializeBaseline(map: Record<string, number>): string {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(map).sort()) {
    const value = map[key];
    if (value !== undefined) sorted[key] = value;
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function isNumberMap(v: unknown): v is Record<string, number> {
  return (
    typeof v === 'object' &&
    v !== null &&
    Object.values(v).every((n) => typeof n === 'number')
  );
}
