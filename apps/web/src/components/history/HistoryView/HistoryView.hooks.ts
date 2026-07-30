/** The web-side merge hook for the global History view: fans out the three
 *  existing per-family bridge list commands in parallel, flattens each run into a
 *  {@link ScanRunSummary}, filters to the active project, and sorts newest-first.
 *
 *  Deliberately NOT a Rust aggregator (spec branch 3): the three list commands
 *  already return full run lists; this hook is the merge seam — and the upgrade
 *  point if a server-side aggregator is ever wanted. It reads only `@/lib/*`, so
 *  History stays a leaf that imports no sibling feature view. */
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useToast } from '@/components/ui';
import {
  deleteHarnessRun,
  deleteInsightRun,
  deleteScorecardRun,
  getAppInfo,
  type HarnessRun,
  type InsightRun,
  listHarnessRuns,
  listInsightRuns,
  listScorecardRuns,
  type ScorecardRun,
} from '@/lib/bridge';

import type {
  AllScanRuns,
  HistoryFamilyFilter,
  HistoryFilters,
  HistoryStatusFilter,
  ScanFamily,
  ScanRunSummary,
} from './HistoryView.types';

/** Per-family delete command. Keyed by family so a new family is one row here, not a
 *  new branch — the same shape the summary mappers use. */
const DELETE_RUN: Record<ScanFamily, (runId: string) => Promise<void>> = {
  insight: deleteInsightRun,
  scorecard: deleteScorecardRun,
  harness: deleteHarnessRun,
};

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
  // The core's per-kind retention cap, probed once (build-time metadata, never
  // changes at runtime). `null` until it resolves — the footer states the rule
  // without a number rather than a placeholder that might be wrong.
  const [retention, setRetention] = useState<number | null>(null);

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

  useEffect(() => {
    void getAppInfo()
      .then((info) => {
        if (mounted.current) setRetention(info.scanRunRetention);
      })
      // A failed probe is non-fatal: the footer just omits the number.
      .catch(() => undefined);
  }, []);

  const refresh = useCallback(() => void load(), [load]);

  /** Delete one run, then drop its row optimistically-after-the-fact (the row leaves
   *  once the core confirms, so a failed delete never hides a run that still exists).
   *  Rejects on failure so the caller can surface it. */
  const deleteRun = useCallback(async (family: ScanFamily, runId: string): Promise<void> => {
    await DELETE_RUN[family](runId);
    if (!mounted.current) return;
    setRuns((prev) => prev.filter((run) => !(run.family === family && run.id === runId)));
  }, []);

  return { runs, loading, error, refresh, retention, deleteRun };
}

/** Narrow the merged run list by family + status. Purely derived — the filters never
 *  re-fetch, so switching them is instant and a background refresh keeps working. */
export function useHistoryFilters(runs: ScanRunSummary[]): HistoryFilters {
  const [family, setFamily] = useState<HistoryFamilyFilter>('all');
  const [status, setStatus] = useState<HistoryStatusFilter>('all');

  const visible = useMemo(
    () =>
      runs.filter(
        (run) =>
          (family === 'all' || run.family === family) &&
          (status === 'all' || run.status === status),
      ),
    [runs, family, status],
  );

  return {
    family,
    status,
    setFamily,
    setStatus,
    visible,
    narrowed: visible.length < runs.length,
  };
}

/** The delete flow's state machine: which run is awaiting confirmation, whether the
 *  delete is in flight, and the three transitions. Kept out of the view body so the
 *  component stays a shell. */
export interface HistoryDelete {
  /** The run awaiting confirmation, or `null` when the dialog is closed. */
  pending: { family: ScanFamily; runId: string; title: string } | null;
  /** True while the confirmed delete is in flight (disables the dialog's buttons). */
  busy: boolean;
  request: (family: ScanFamily, runId: string) => void;
  confirm: () => void;
  cancel: () => void;
}

/** Confirm-then-delete for one run. Deleting a run is irreversible (the core unlinks
 *  its JSON), so it always goes through {@link ConfirmDialog} — never a bare click —
 *  and a failure surfaces as a toast with the row left in place. */
export function useHistoryDelete(
  runs: ScanRunSummary[],
  deleteRun: (family: ScanFamily, runId: string) => Promise<void>,
): HistoryDelete {
  const toast = useToast();
  const [pending, setPending] = useState<HistoryDelete['pending']>(null);
  const [busy, setBusy] = useState(false);

  const request = useCallback(
    (family: ScanFamily, runId: string) => {
      const run = runs.find((r) => r.family === family && r.id === runId);
      setPending({ family, runId, title: run?.title ?? 'this run' });
      setBusy(false);
    },
    [runs],
  );

  const cancel = useCallback(() => setPending(null), []);

  const confirm = useCallback(() => {
    if (pending === null) return;
    const { family, runId } = pending;
    setBusy(true);
    void deleteRun(family, runId)
      .then(() => {
        toast.push({ tone: 'success', title: 'Run deleted' });
        setPending(null);
      })
      .catch((err: unknown) => {
        toast.error('Could not delete this run', err);
      })
      .finally(() => setBusy(false));
  }, [pending, deleteRun, toast]);

  return { pending, busy, request, confirm, cancel };
}

/** Estimated row height (px) before measurement. History rows are fixed-height
 *  flex rows (badge + title + receipt + status chip); `measureElement` corrects
 *  each mounted row to its real size, so this only needs to be close. */
const ESTIMATED_ROW_HEIGHT = 49;

/** Extra rows rendered above/below the viewport so a fast scroll never flashes blank. */
const ROW_OVERSCAN = 8;

/** The virtualization surface a virtualized list needs: a ref-setter for the
 *  scroll container plus the vertical virtualizer over the run list. */
export interface HistoryListView {
  /** Ref for the inner scroll container — the virtualizer's scroll element. */
  setScrollRef: (element: HTMLDivElement | null) => void;
  /** The vertical virtualizer over the run list. */
  virtualizer: Virtualizer<HTMLDivElement, Element>;
}

/**
 * Vertical virtualization for the History run list so only the visible rows
 * mount. `useAllScanRuns` merges every family's full run list with no limit, so
 * an accumulating history would otherwise grow the DOM unbounded (one row per
 * run). Mirrors the board column's `useColumn` virtualizer: a scroll-element
 * ref, a fixed `estimateSize`, `measureElement` for real heights, and stable
 * `family:id` keys so a refresh/re-sort reconciles rows correctly.
 */
export function useHistoryVirtualizer(runs: ScanRunSummary[]): HistoryListView {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const setScrollRef = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
  }, []);

  const virtualizer = useVirtualizer({
    count: runs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: ROW_OVERSCAN,
    // `id` alone collides across families (an Insight and a Harness run can share
    // an id), so key on `family:id` — the same compound key the list markup uses.
    // A stable, unique key is required for correct reconciliation when the merge
    // hook re-sorts or a refresh swaps the list.
    getItemKey: (index) => {
      const run = runs[index];
      return run !== undefined ? `${run.family}:${run.id}` : index;
    },
  });

  return { setScrollRef, virtualizer };
}
