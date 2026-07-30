/**
 * Drift carry-forward (#279): the run-over-run comparison between the EnforceRun the
 * panel is showing and the run carried forward beside it — "2 newly drifted · 1
 * resolved · −5 sites".
 *
 * This is the same shape as the Insight run-over-run delta
 * (`components/insight/insight-delta.ts`) and deliberately so: a comparison across
 * runs is only honest when both runs measured the SAME GROUND, and every family that
 * grows one keeps re-learning that. The differences from Insight are that drift is
 * MEASURED rather than found (so a change is a count moving, not a fingerprint
 * appearing) and that both snapshots come from ONE project-local file
 * (`.nightcore/checks-last-run.json`), so project identity is structural here and does
 * not need to be in the basis.
 *
 * The comparability basis is the load-bearing part. Two EnforceRuns are diffable only
 * when:
 *   - the run MEASURED something. A run with no drift records swept no ground at all
 *     (nothing armed, or every drift check disarmed), so a missing convention means
 *     "never looked", not "fixed";
 *   - the same set of conventions was measured, BY THE SAME METHOD. Arming or
 *     disarming a drift check changes what was looked at, and re-compiling a
 *     convention onto a different substrate changes what the counts even mean
 *     (lint-meta's `sitesChecked` is a lower bound, ESLint's is a real file count) —
 *     either way the diff would manufacture "new"/"resolved";
 *   - the runs were the same DEPTH. A deep conformance audit reaches conventions no
 *     mechanical check can express, so diffing across depth reports the extra ground
 *     as wholly new (or wholly resolved in the other direction).
 * When the basis does not match, the panel says which condition failed instead of
 * showing a number the user would read as fact.
 *
 * Per convention the delta is only a NUMBER when both runs measured it definitively
 * (a `clean`/`drifted` record with `sitesChecked > 0`). A convention that errored on
 * either side is reported as `not-measured`, never folded into a count — the same
 * fail-visible rule the drift records themselves obey.
 */
import type { ConventionDriftVM } from './harness.types';

/** Why no run-over-run drift comparison is shown. Each maps to its own UI sentence. */
export type DriftDeltaBlocker =
  /** Nothing has been carried forward yet (this is the first measuring run). */
  | 'no-earlier-run'
  /** The displayed run measured nothing, so it cannot anchor a comparison. */
  | 'run-not-diffable'
  /** Both runs measured, but not the same ground (armed set / substrate / depth). */
  | 'ground-changed';

/** One run's measured ground — the inputs the comparability basis is computed from. */
export interface DriftSnapshot {
  /** Every drift record the run produced. */
  drift: readonly ConventionDriftVM[];
  /** Whether the run included the opt-in deep conformance audit. */
  deep: boolean;
}

/** How one convention's conformance moved between the two runs. */
export type DriftChange =
  /** Clean before, violating now. */
  | 'newly-drifted'
  /** Violating before, clean now. */
  | 'resolved'
  /** Still violating, at MORE sites. */
  | 'worsened'
  /** Still violating, at FEWER sites. */
  | 'improved'
  /** Same count on both sides (including clean → clean). */
  | 'unchanged'
  /** At least one side has no definitive measurement — never given a number. */
  | 'not-measured';

/** One convention's movement, keyed in {@link DriftRunDelta.byFingerprint}. */
export interface ConventionDriftDelta {
  change: DriftChange;
  /** Violating sites now / before — `null` when that side was not definitive. */
  sitesMatched: number | null;
  previousSitesMatched: number | null;
}

/** The comparison against the carried-forward run. */
export interface DriftRunDelta {
  /** When the compared-against run finished (epoch ms) — the view renders it
   *  relatively. Always shown: the carried-forward run is the most recent one that
   *  MEASURED something, which is not necessarily the run just before this one. */
  previousRanAt: number;
  newlyDrifted: number;
  resolved: number;
  worsened: number;
  improved: number;
  unchanged: number;
  notMeasured: number;
  /** Net change in violating sites across the conventions BOTH runs measured
   *  definitively (negative = fewer violations now). */
  siteDelta: number;
  byFingerprint: ReadonlyMap<string, ConventionDriftDelta>;
}

/** Either the comparison, or the reason there isn't one. */
export type DriftDeltaResult =
  | { kind: 'delta'; delta: DriftRunDelta }
  | { kind: 'unavailable'; blocker: DriftDeltaBlocker };

/** Whether a record is a definitive measurement — the only state a count may be read
 *  from. `errored`/`uncheckable`, or a `sitesChecked` of 0, mean the run did not
 *  actually establish this convention's conformance. */
function isDefinitive(d: ConventionDriftVM): boolean {
  return (d.status === 'clean' || d.status === 'drifted') && d.sitesChecked > 0;
}

/**
 * The GROUND signature of an EnforceRun: two runs may only be diffed when this matches
 * exactly. `null` means the run cannot participate in a comparison at all.
 *
 * The ground is every convention the run ATTEMPTED, paired with the method that
 * attempted it — outcomes are deliberately excluded, so a rule that errors in one run
 * still leaves the two runs comparable overall (that one convention is then reported
 * `not-measured` rather than blocking the whole comparison).
 */
export function driftComparabilityBasis(run: DriftSnapshot): string | null {
  // Measured nothing ⇒ swept no ground ⇒ nothing to compare.
  if (run.drift.length === 0) return null;
  // A SET: order is an artifact of manifest order, and a duplicate is meaningless.
  const ground = [...new Set(run.drift.map((d) => `${d.conventionFingerprint}::${d.method}`))]
    .sort()
    .join(',');
  return [run.deep ? 'deep' : 'standard', ground].join('|');
}

/** Classify one convention's movement from its two (possibly missing) records. */
function classify(
  now: ConventionDriftVM | undefined,
  before: ConventionDriftVM | undefined,
): ConventionDriftDelta {
  const nowOk = now !== undefined && isDefinitive(now);
  const beforeOk = before !== undefined && isDefinitive(before);
  if (!nowOk || !beforeOk) {
    return {
      change: 'not-measured',
      sitesMatched: nowOk ? now.sitesMatched : null,
      previousSitesMatched: beforeOk ? before.sitesMatched : null,
    };
  }
  const a = now.sitesMatched;
  const b = before.sitesMatched;
  let change: DriftChange;
  if (a === b) change = 'unchanged';
  else if (b === 0) change = 'newly-drifted';
  else if (a === 0) change = 'resolved';
  else change = a > b ? 'worsened' : 'improved';
  return { change, sitesMatched: a, previousSitesMatched: b };
}

/**
 * Compare the displayed EnforceRun against the run carried forward beside it.
 *
 * `previous` is `null` until a second measuring run has happened. Both snapshots come
 * from the same project's `checks-last-run.json`, so they are the same project by
 * construction.
 */
export function computeDriftDelta(
  current: DriftSnapshot,
  previous: (DriftSnapshot & { ranAt: number }) | null,
): DriftDeltaResult {
  const basis = driftComparabilityBasis(current);
  if (basis === null) return { kind: 'unavailable', blocker: 'run-not-diffable' };
  if (previous === null) return { kind: 'unavailable', blocker: 'no-earlier-run' };
  const previousBasis = driftComparabilityBasis(previous);
  if (previousBasis === null) return { kind: 'unavailable', blocker: 'no-earlier-run' };
  if (previousBasis !== basis) return { kind: 'unavailable', blocker: 'ground-changed' };

  const before = new Map(previous.drift.map((d) => [d.conventionFingerprint, d]));
  const byFingerprint = new Map<string, ConventionDriftDelta>();
  const tally = {
    newlyDrifted: 0,
    resolved: 0,
    worsened: 0,
    improved: 0,
    unchanged: 0,
    notMeasured: 0,
    siteDelta: 0,
  };
  for (const d of current.drift) {
    const entry = classify(d, before.get(d.conventionFingerprint));
    byFingerprint.set(d.conventionFingerprint, entry);
    if (entry.change === 'not-measured') {
      tally.notMeasured += 1;
      continue;
    }
    // Safe: a non-`not-measured` classification only comes from two definitive sides.
    tally.siteDelta += (entry.sitesMatched ?? 0) - (entry.previousSitesMatched ?? 0);
    if (entry.change === 'newly-drifted') tally.newlyDrifted += 1;
    else if (entry.change === 'resolved') tally.resolved += 1;
    else if (entry.change === 'worsened') tally.worsened += 1;
    else if (entry.change === 'improved') tally.improved += 1;
    else tally.unchanged += 1;
  }

  return {
    kind: 'delta',
    delta: { previousRanAt: previous.ranAt, ...tally, byFingerprint },
  };
}
