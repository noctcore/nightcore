/** The web-side merge hook for the global History view: fans out the three
 *  existing per-family bridge list commands in parallel, flattens each run into a
 *  {@link ScanRunSummary}, filters to the active project, and sorts newest-first.
 *
 *  Deliberately NOT a Rust aggregator (spec branch 3): the three list commands
 *  already return full run lists; this hook is the merge seam — and the upgrade
 *  point if a server-side aggregator is ever wanted. It reads only `@/lib/*`, so
 *  History stays a leaf that imports no sibling feature view. */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type HarnessRun,
  type InsightRun,
  listHarnessRuns,
  listInsightRuns,
  listScorecardRuns,
  type ScorecardRun,
} from '@/lib/bridge';

import type { AllScanRuns, ScanRunSummary } from './HistoryView.types';

/** `N noun` / `N nouns` — the count labels the run-history menus already use. */
function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function insightSummary(run: InsightRun): ScanRunSummary {
  return {
    id: run.id,
    family: 'insight',
    title: countLabel(run.findings.length, 'finding'),
    status: run.status,
    createdAt: run.createdAt,
    projectPath: run.projectPath,
    model: run.model,
    costUsd: run.costUsd,
    durationMs: run.durationMs,
  };
}

function scorecardSummary(run: ScorecardRun): ScanRunSummary {
  return {
    id: run.id,
    family: 'scorecard',
    title: `${countLabel(run.readings.length, 'dimension')} graded`,
    status: run.status,
    createdAt: run.createdAt,
    projectPath: run.projectPath,
    model: run.model,
    costUsd: run.costUsd,
    durationMs: run.durationMs,
  };
}

function harnessSummary(run: HarnessRun): ScanRunSummary {
  return {
    id: run.id,
    family: 'harness',
    title: countLabel(run.findings.length, 'convention'),
    status: run.status,
    createdAt: run.createdAt,
    projectPath: run.projectPath,
    model: run.model,
    costUsd: run.costUsd,
    durationMs: run.durationMs,
  };
}

/**
 * Merge every single-run scan family's history for `projectPath`.
 *
 * Loads on mount (and on project change) and refreshes on window focus and via
 * the returned `refresh`. Uses `allSettled` so one family rejecting (a backend
 * error inside Tauri) never blanks the view: the loaded families still merge and
 * `error` names the ones that failed. A stale in-flight load is discarded via a
 * monotonic load id, so an out-of-order response can't overwrite newer state.
 */
export function useAllScanRuns(projectPath: string | null): AllScanRuns {
  const [runs, setRuns] = useState<ScanRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadId = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const id = ++loadId.current;
    // No active project: nothing to fetch — show the empty state, not a spinner.
    if (projectPath === null) {
      if (mounted.current && id === loadId.current) {
        setRuns([]);
        setError(null);
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    const [insight, scorecard, harness] = await Promise.allSettled([
      listInsightRuns(),
      listScorecardRuns(),
      listHarnessRuns(),
    ]);
    // A newer load (project change / refresh) superseded this one, or we unmounted.
    if (!mounted.current || id !== loadId.current) return;

    const merged: ScanRunSummary[] = [];
    const failed: string[] = [];
    if (insight.status === 'fulfilled') merged.push(...insight.value.map(insightSummary));
    else failed.push('Insight');
    if (scorecard.status === 'fulfilled') merged.push(...scorecard.value.map(scorecardSummary));
    else failed.push('Scorecard');
    if (harness.status === 'fulfilled') merged.push(...harness.value.map(harnessSummary));
    else failed.push('Harness');

    const filtered = merged
      .filter((run) => run.projectPath === projectPath)
      .sort((a, b) => b.createdAt - a.createdAt);

    setRuns(filtered);
    setError(
      failed.length > 0
        ? `Couldn’t load ${failed.join(' & ')} history — showing what loaded.`
        : null,
    );
    setLoading(false);
  }, [projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh when the window regains focus — a run finished in another surface
  // while History stayed mounted (spec: refreshes on remount/focus, no live tick).
  useEffect(() => {
    const onFocus = (): void => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const refresh = useCallback(() => void load(), [load]);

  return { runs, loading, error, refresh };
}
