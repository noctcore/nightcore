/**
 * Insight run-over-run delta (issue #403): the fingerprint set-diff between the
 * displayed run and the previous COMPARABLE run — "4 new · 3 resolved · 5
 * persisting".
 *
 * This is deliberately the HEURISTIC half of compare-over-time, and the copy it
 * feeds says so. A finding is matched purely by its content fingerprint
 * (`file | normalized title`, assigned by the engine — see
 * `packages/engine/src/scans/shared/findings.ts`), so nothing here knows whether two
 * runs are talking about the SAME underlying problem: reword a finding's title
 * between runs and it reads as one "resolved" plus one "new". That is why every
 * number this module produces is labelled **apparent** in the UI and never asserted
 * as ground truth. The grounded answer is engine re-identification (v0.5, roadmap
 * §7): feed prior-run finding digests into the scan passes so a carried-forward
 * finding gets a real `previousFindingId`. Do NOT grow this module into that.
 *
 * The comparability gate is the load-bearing part. Two runs are only diffable when
 * their COVERAGE was the same — otherwise the diff invents findings:
 *   - a DEEP run finds strictly more than a standard one, so diffing across depth
 *     manufactures "new" (and "resolved" in the other direction);
 *   - a different CATEGORY set means the categories only one run swept look either
 *     wholly new or wholly resolved;
 *   - `diff` scope covers only what changed against HEAD at run time, and that
 *     file set is not persisted — so its coverage can never be shown equal to
 *     anything, not even another `diff` run;
 *   - a run that did not COMPLETE (failed / cancelled) has partial coverage, so a
 *     missing fingerprint means "never looked", not "fixed";
 *   - a run matching the usage-limit signature ($0 + no input tokens) completed
 *     without the provider doing any work at all — its empty findings are an
 *     artifact, so comparing it would report the entire previous run "resolved".
 * When nothing passes the gate the view says so explicitly rather than showing a
 * comparison the user would read as fact.
 *
 * Insight-local on purpose: only this family ships the delta today. If a second
 * scan family grows one, hoist the diff into `@/lib/scan-run` then — not before.
 */
import type { InsightRun } from '@/lib/bridge';
import { isUsageLimitSignature } from '@/lib/scan-run';

/** Why no run-over-run comparison is shown. Each maps to its own UI sentence. */
export type InsightDeltaBlocker =
  /** The displayed run is the project's first (nothing earlier persisted). */
  | 'no-earlier-run'
  /** The displayed run itself can't anchor a diff (running / failed / cancelled,
   *  `diff` scope, unknown depth, or the $0 usage-limit signature). */
  | 'run-not-diffable'
  /** Earlier runs exist, but none of them swept comparable ground. */
  | 'no-comparable-run';

/** The apparent set-diff against one previous comparable run. */
export interface InsightRunDelta {
  /** Fingerprints present now and absent from the previous run. */
  apparentNew: number;
  /** Fingerprints the previous run had and this one no longer reports. */
  apparentResolved: number;
  /** Fingerprints present in both runs. */
  persisting: number;
  /** The run compared against. */
  previousRunId: string;
  /** That run's creation time (epoch ms) — the view renders it relatively. */
  previousRunCreatedAt: number;
  /** That run's model. */
  previousRunModel: string;
  /** Whether the two runs ran on DIFFERENT models. Comparability deliberately
   *  ignores the model (models change constantly and a model swap is not a coverage
   *  change), but a cross-model diff is even weaker evidence — the view discloses it. */
  modelChanged: boolean;
}

/** Either the apparent diff, or the reason there isn't one. */
export type InsightDeltaResult =
  | { kind: 'delta'; delta: InsightRunDelta }
  | { kind: 'unavailable'; blocker: InsightDeltaBlocker };

/**
 * The COVERAGE signature of a run: two runs may only be diffed when this matches
 * exactly. `null` means the run cannot participate in a diff at all (see the module
 * comment for each condition).
 */
export function comparabilityBasis(run: InsightRun): string | null {
  // A run that didn't finish cleanly, or finished without the provider doing any
  // work, has coverage nobody can vouch for.
  if (run.status !== 'completed') return null;
  if (
    isUsageLimitSignature({
      status: run.status,
      costUsd: run.costUsd,
      inputTokens: run.usage.inputTokens,
    })
  ) {
    return null;
  }
  // `diff` scope's coverage is a git state that isn't persisted — unknowable.
  if (run.scope !== 'repo') return null;
  // Depth is unknown on runs persisted before #403 — fail closed rather than
  // assume a shallow run and diff it against a deep one.
  if (run.deep === null) return null;
  // Categories are a SET: order is a UI artifact, and a duplicate is meaningless.
  const categories = [...new Set(run.categories)].sort().join(',');
  return [run.projectPath, run.scope, run.deep ? 'deep' : 'standard', categories].join('|');
}

/** Every distinct finding fingerprint a run reported, regardless of the user's
 *  lifecycle marks — dismissing or converting a finding annotates it, it does not
 *  unfind it, so all three statuses count toward coverage. */
function fingerprintsOf(run: InsightRun): Set<string> {
  return new Set(run.findings.map((f) => f.fingerprint));
}

/**
 * Diff the displayed run against the most recent comparable run before it.
 *
 * `runs` is the persisted run list (any order; `list_insight_runs` yields
 * newest-first). The predecessor is the comparable run with the greatest
 * `createdAt` strictly below the current run's — ties broken toward the run whose
 * id sorts lower, so the pick is deterministic when two runs share a timestamp.
 */
export function computeInsightRunDelta(
  runs: readonly InsightRun[],
  currentRunId: string | null,
): InsightDeltaResult {
  const current = runs.find((r) => r.id === currentRunId);
  // Not (yet) persisted — a live run mid-flight has no diffable basis either.
  if (current === undefined) return { kind: 'unavailable', blocker: 'run-not-diffable' };

  const basis = comparabilityBasis(current);
  if (basis === null) return { kind: 'unavailable', blocker: 'run-not-diffable' };

  const earlier = runs.filter(
    (r) =>
      r.id !== current.id &&
      (r.createdAt < current.createdAt ||
        (r.createdAt === current.createdAt && r.id < current.id)),
  );
  if (earlier.length === 0) {
    return { kind: 'unavailable', blocker: 'no-earlier-run' };
  }

  let previous: InsightRun | undefined;
  for (const run of earlier) {
    if (comparabilityBasis(run) !== basis) continue;
    if (
      previous === undefined ||
      run.createdAt > previous.createdAt ||
      (run.createdAt === previous.createdAt && run.id > previous.id)
    ) {
      previous = run;
    }
  }
  if (previous === undefined) {
    return { kind: 'unavailable', blocker: 'no-comparable-run' };
  }

  const now = fingerprintsOf(current);
  const before = fingerprintsOf(previous);
  let persisting = 0;
  for (const fp of now) if (before.has(fp)) persisting++;
  return {
    kind: 'delta',
    delta: {
      apparentNew: now.size - persisting,
      apparentResolved: before.size - persisting,
      persisting,
      previousRunId: previous.id,
      previousRunCreatedAt: previous.createdAt,
      previousRunModel: previous.model,
      modelChanged: previous.model !== current.model,
    },
  };
}
