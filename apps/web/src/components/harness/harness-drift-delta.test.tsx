/** Drift carry-forward (#279): the comparability gate and the run-over-run movement.
 *  The gate is the load-bearing part — every case here asserts that a comparison is
 *  either grounded in the SAME measured ground or refused with a named blocker. */
import { expect, test } from 'vitest';

import type { ConventionDriftVM } from './harness.types';
import {
  computeDriftDelta,
  driftComparabilityBasis,
  type DriftSnapshot,
} from './harness-drift-delta';

function rec(over: Partial<ConventionDriftVM> = {}): ConventionDriftVM {
  const fp = over.conventionFingerprint ?? 'fp1';
  return {
    id: `drift-${fp}`,
    conventionFingerprint: fp,
    category: 'imports-boundaries',
    title: 'a convention',
    status: 'clean',
    method: 'lint-meta: a-rule',
    sitesMatched: 0,
    sitesChecked: 10,
    checkName: 'a-rule',
    errorReason: null,
    ...over,
    fingerprint: fp,
  };
}

function snap(drift: ConventionDriftVM[], deep = false): DriftSnapshot {
  return { drift, deep };
}

function prev(drift: ConventionDriftVM[], deep = false) {
  return { drift, deep, ranAt: 1_700_000_000_000 };
}

test('a run that measured nothing has no basis and cannot be compared', () => {
  expect(driftComparabilityBasis(snap([]))).toBeNull();
  const result = computeDriftDelta(snap([]), prev([rec()]));
  expect(result).toEqual({ kind: 'unavailable', blocker: 'run-not-diffable' });
});

test('the first measuring run has nothing carried forward', () => {
  const result = computeDriftDelta(snap([rec()]), null);
  expect(result).toEqual({ kind: 'unavailable', blocker: 'no-earlier-run' });
});

test('the basis ignores record ORDER but not the measured set', () => {
  const a = rec({ conventionFingerprint: 'a' });
  const b = rec({ conventionFingerprint: 'b' });
  expect(driftComparabilityBasis(snap([a, b]))).toBe(driftComparabilityBasis(snap([b, a])));
  expect(driftComparabilityBasis(snap([a]))).not.toBe(driftComparabilityBasis(snap([a, b])));
});

test('arming another drift check changes the ground, so no trend is shown', () => {
  const a = rec({ conventionFingerprint: 'a', status: 'drifted', sitesMatched: 2 });
  const b = rec({ conventionFingerprint: 'b' });
  // The new run measures one MORE convention — the extra one is not "newly drifted".
  const result = computeDriftDelta(snap([a, b]), prev([a]));
  expect(result).toEqual({ kind: 'unavailable', blocker: 'ground-changed' });
});

test('re-compiling a convention onto another substrate changes the ground', () => {
  const viaLintMeta = rec({ method: 'lint-meta: a-rule' });
  // Same convention, same counts — but ESLint's sitesChecked means something else.
  const viaEslint = rec({ method: 'eslint: local/a-rule' });
  const result = computeDriftDelta(snap([viaEslint]), prev([viaLintMeta]));
  expect(result).toEqual({ kind: 'unavailable', blocker: 'ground-changed' });
});

test('a deep run is never diffed against a shallow one', () => {
  const r = rec();
  expect(driftComparabilityBasis(snap([r], true))).not.toBe(
    driftComparabilityBasis(snap([r], false)),
  );
  const result = computeDriftDelta(snap([r], true), prev([r], false));
  expect(result).toEqual({ kind: 'unavailable', blocker: 'ground-changed' });
});

test('the same ground yields per-convention movement and a net site delta', () => {
  const before = [
    rec({ conventionFingerprint: 'a', status: 'clean', sitesMatched: 0 }),
    rec({ conventionFingerprint: 'b', status: 'drifted', sitesMatched: 4 }),
    rec({ conventionFingerprint: 'c', status: 'drifted', sitesMatched: 2 }),
    rec({ conventionFingerprint: 'd', status: 'drifted', sitesMatched: 1 }),
    rec({ conventionFingerprint: 'e', status: 'clean', sitesMatched: 0 }),
  ];
  const now = [
    rec({ conventionFingerprint: 'a', status: 'drifted', sitesMatched: 3 }), // newly drifted
    rec({ conventionFingerprint: 'b', status: 'clean', sitesMatched: 0 }), // resolved
    rec({ conventionFingerprint: 'c', status: 'drifted', sitesMatched: 5 }), // worsened
    rec({ conventionFingerprint: 'd', status: 'drifted', sitesMatched: 1 }), // unchanged
    rec({ conventionFingerprint: 'e', status: 'clean', sitesMatched: 0 }), // unchanged
  ];
  const result = computeDriftDelta(snap(now), prev(before));
  expect(result.kind).toBe('delta');
  if (result.kind !== 'delta') return;
  const d = result.delta;
  expect(d.newlyDrifted).toBe(1);
  expect(d.resolved).toBe(1);
  expect(d.worsened).toBe(1);
  expect(d.improved).toBe(0);
  expect(d.unchanged).toBe(2);
  expect(d.notMeasured).toBe(0);
  // (3-0) + (0-4) + (5-2) + 0 + 0
  expect(d.siteDelta).toBe(2);
  expect(d.previousRanAt).toBe(1_700_000_000_000);
  expect(d.byFingerprint.get('a')?.change).toBe('newly-drifted');
  expect(d.byFingerprint.get('c')).toEqual({
    change: 'worsened',
    sitesMatched: 5,
    previousSitesMatched: 2,
  });
});

test('fewer violating sites on the same convention reads as improved', () => {
  const before = [rec({ status: 'drifted', sitesMatched: 9 })];
  const now = [rec({ status: 'drifted', sitesMatched: 4 })];
  const result = computeDriftDelta(snap(now), prev(before));
  if (result.kind !== 'delta') throw new Error('expected a delta');
  expect(result.delta.improved).toBe(1);
  expect(result.delta.siteDelta).toBe(-5);
});

test('a side without a definitive measurement is never given a number', () => {
  // The ground is unchanged (same fingerprint + method), but this run ERRORED, so
  // the convention must be reported as not-measured rather than "resolved".
  const before = [rec({ status: 'drifted', sitesMatched: 6 })];
  const now = [
    rec({ status: 'errored', sitesMatched: 0, sitesChecked: 0, errorReason: 'rule threw' }),
  ];
  const result = computeDriftDelta(snap(now), prev(before));
  if (result.kind !== 'delta') throw new Error('expected a delta');
  expect(result.delta.notMeasured).toBe(1);
  expect(result.delta.resolved).toBe(0);
  expect(result.delta.siteDelta).toBe(0);
  expect(result.delta.byFingerprint.get('fp1')).toEqual({
    change: 'not-measured',
    sitesMatched: null,
    previousSitesMatched: 6,
  });
});

test('a `clean` claiming zero examined sites is not a definitive measurement', () => {
  // The fail-visible rule: sitesChecked 0 ⇒ counts unknown ⇒ never a comparable clean.
  const before = [rec({ status: 'drifted', sitesMatched: 3 })];
  const now = [rec({ status: 'clean', sitesMatched: 0, sitesChecked: 0 })];
  const result = computeDriftDelta(snap(now), prev(before));
  if (result.kind !== 'delta') throw new Error('expected a delta');
  expect(result.delta.notMeasured).toBe(1);
  expect(result.delta.resolved).toBe(0);
});
