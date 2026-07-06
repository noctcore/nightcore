// @ts-check
import type { IMetaCtx } from './types';

/**
 * A generic ratchet baseline for lint-meta rules (issue #17 phase C; the pattern
 * issue #50's web file-size ratchet reuses).
 *
 * A baseline is a committed `baselines/<rule-id>.json` — a flat `key → number` map
 * freezing today's offenders at their current metric. The ratchet is one-way: an
 * offender that is recorded AND has not grown past its frozen value is
 * grandfathered (suppressed); a NEW offender, or a recorded one that GREW, is a
 * live violation. As each offender is fixed, its entry is deleted (or lowered),
 * never raised — the frozen debt only shrinks.
 *
 * The `key` is opaque to this module: a rule with more than one metric family
 * (e.g. `rust-module-shape`'s size + manifest) namespaces its keys (`size:<file>`,
 * `manifest:<file>`) so one flat map serves both.
 */

/** Load a rule's committed baseline, or `{}` when none exists yet. */
export function loadBaseline(ctx: IMetaCtx, ruleId: string): Record<string, number> {
  const raw = ctx.read(`tools/lint-meta/baselines/${ruleId}.json`);
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
  for (const key of Object.keys(map).sort()) sorted[key] = map[key];
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function isNumberMap(v: unknown): v is Record<string, number> {
  return (
    typeof v === 'object' &&
    v !== null &&
    Object.values(v).every((n) => typeof n === 'number')
  );
}
