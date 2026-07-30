/** Drift data seam: the wire→view normalizer for the measured per-convention
 *  conformance carried on `ArmedChecksState.drift`, plus the {@link useArmedDrift}
 *  fetch that reads it — together with the CARRIED-FORWARD previous run (#279) — and
 *  hands both to the Enforce coverage panel. The panel JOINS the records to its
 *  coverage records by `conventionFingerprint` (coverage answers "is there a rule?",
 *  drift answers "is it FOLLOWED at every site?") and compares the two runs through
 *  `harness-drift-delta.ts`. No new bridge command — the checks state already carries
 *  everything; this reuses `list_armed_checks`. Sibling of the coverage normalizers in
 *  `harness-coverage.ts`. */
import { useEffect, useState } from 'react';

import { type ConventionDrift, listArmedChecks } from '@/lib/bridge';

import type { ConventionDriftVM } from './harness.types';

/** The measured drift for the Enforce panel: the displayed EnforceRun plus the run
 *  carried forward beside it (`null` until a second measuring run has happened). */
export interface ArmedDriftView {
  drift: ConventionDriftVM[];
  /** Whether the displayed run included the opt-in deep conformance audit. */
  deep: boolean;
  /** The carried-forward predecessor — the most recent EARLIER run that measured
   *  something, which is not necessarily the run just before this one. */
  previous: { drift: ConventionDriftVM[]; deep: boolean; ranAt: number } | null;
}

/** The honest empty view: no drift, no comparison — never a fabricated "clean". */
const EMPTY_DRIFT: ArmedDriftView = { drift: [], deep: false, previous: null };

/** Map a wire `ConventionDrift` (carried on `ArmedChecksState.drift`, string-typed
 *  `status`) into the view shape, narrowing the wire string to the
 *  `ConventionDriftStatus` union (mirrors `storedToCoverageGap`). */
export function driftToVM(d: ConventionDrift): ConventionDriftVM {
  return {
    id: d.id,
    conventionFingerprint: d.conventionFingerprint,
    category: d.category,
    title: d.title,
    status: d.status as ConventionDriftVM['status'],
    method: d.method,
    sitesMatched: d.sitesMatched,
    sitesChecked: d.sitesChecked,
    checkName: d.checkName ?? null,
    errorReason: d.errorReason ?? null,
    fingerprint: d.fingerprint,
  };
}

/** Read the active project's measured drift (the `drift` on the armed-checks state
 *  from the LAST EnforceRun, plus the carried-forward previous run) for the Enforce
 *  coverage panel. Gated on `active` so the fetch fires when the Conventions section is
 *  showing coverage AND re-fires each time the user returns to it — so a "Run armed
 *  checks now" performed on the Checks section is reflected on the next visit without a
 *  shared store. Drift is a supplementary signal: a failed read leaves the coverage
 *  panel intact and drift simply reads "not measured yet" (the honest empty state),
 *  never a fake "clean". */
export function useArmedDrift(active: boolean): ArmedDriftView {
  const [view, setView] = useState<ArmedDriftView>(EMPTY_DRIFT);

  useEffect(() => {
    if (!active) return;
    let live = true;
    void (async () => {
      try {
        const state = await listArmedChecks();
        if (!live) return;
        const previous = state.previousRun;
        setView({
          drift: state.drift.map(driftToVM),
          deep: state.lastRun?.deep ?? false,
          previous:
            previous === undefined
              ? null
              : {
                  drift: previous.drift.map(driftToVM),
                  deep: previous.deep,
                  ranAt: previous.ranAt,
                },
        });
      } catch {
        // Swallow — drift is supplementary; the coverage panel renders without it.
        if (live) setView(EMPTY_DRIFT);
      }
    })();
    return () => {
      live = false;
    };
  }, [active]);

  return view;
}
