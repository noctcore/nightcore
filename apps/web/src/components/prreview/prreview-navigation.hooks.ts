/**
 * The PR workspace's navigation actions — split out of the PrReviewView
 * mega-hook. These are the callbacks that MUTATE the navigation state
 * (selectedPr / viewingRunId / reconfiguring / startingPrs) and, on every
 * navigation, reset the downstream finding UI and close the human gates. They
 * live BELOW the projections + selection + gates in the composition because they
 * read the displayed stream and drive the selection/gate resets.
 */
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useRef,
} from 'react';

import { type MenuItem, useToast } from '@/components/ui';
import type { PrReviewRun } from '@/lib/bridge';
import { type EffortLevel, type ReviewLens } from '@/lib/bridge';
import type { ScanTarget } from '@/lib/source-ref';
import { usePreselectNavigation } from '@/lib/usePreselectNavigation';
import type { RunConfig } from '@/lib/useRunConfig';

import type { UsePrReviewRunsResult } from './prreview-runs.hooks';
import type { ReviewStream } from './prreview-stream';

/** Everything the navigation actions read and mutate (threaded by the composition). */
export interface PrReviewNavigationConfig {
  selectedPr: number | null;
  setSelectedPr: Dispatch<SetStateAction<number | null>>;
  setViewingRunId: Dispatch<SetStateAction<string | null>>;
  setReconfiguring: Dispatch<SetStateAction<boolean>>;
  setStartingPrs: Dispatch<SetStateAction<ReadonlySet<number>>>;
  runs: UsePrReviewRunsResult;
  config: RunConfig<ReviewLens>;
  /** The displayed stream (source of the "New review" prefill + cancel target). */
  displayStream: ReviewStream | null;
  /** The displayed run's id when running (the per-run cancel target), else null. */
  runningRunId: string | null;
  /** The selected PR's persisted run history, newest first (the history menu). */
  prHistory: PrReviewRun[];
  /** Drop the per-run finding UI (detail panel, selection, bulk counters). */
  resetFindingUi: () => void;
  /** Open a finding's detail panel (the preselect provenance target). */
  setSelectedId: (id: string | null) => void;
  /** Close every human gate (each was armed against the previous selection). */
  closeGates: () => void;
  /** A board→scan provenance target to consume once, or null. */
  preselect: ScanTarget | null | undefined;
  onPreselectConsumed?: () => void;
}

/** The navigation actions the workspace + review section fire. */
export interface PrReviewNavigationApi {
  /** Select a PR. NEVER cancels anything — runs keep streaming in the registry. */
  selectPr: (prNumber: number | null) => void;
  /** Display a specific past run of the selected PR (authoritative reload). */
  viewRun: (runId: string) => void;
  /** Return to the PR's latest run. */
  backToLatest: () => void;
  /** Leave a "New review" reconfigure back to the existing results. */
  backToResults: () => void;
  /** This PR's persisted runs (newest first) as history menu entries. */
  historyItems: MenuItem[];
  /** Start a review of the selected PR with the current config. */
  onReview: () => void;
  /** Cancel the displayed run (a no-op while its id is still unknown). */
  onCancelRun: () => void;
  /** "New review": re-open config prefilled from the displayed run. */
  startNewReview: () => void;
}

/** Own the workspace's navigation actions + the preselect provenance wiring. */
export function usePrReviewNavigation({
  selectedPr,
  setSelectedPr,
  setViewingRunId,
  setReconfiguring,
  setStartingPrs,
  runs,
  config,
  displayStream,
  runningRunId,
  prHistory,
  resetFindingUi,
  setSelectedId,
  closeGates,
  preselect,
  onPreselectConsumed,
}: PrReviewNavigationConfig): PrReviewNavigationApi {
  const toast = useToast();
  const { start, cancel, selectRun } = runs;

  const selectPr = useCallback(
    (prNumber: number | null) => {
      // Selection ONLY: any in-flight run keeps streaming in the registry and
      // shows as a badge in the list (and every fix keeps its per-PR state).
      setSelectedPr(prNumber);
      setViewingRunId(null);
      setReconfiguring(false);
      resetFindingUi();
      // Close ALL the human gates — they were armed against the previous PR's
      // selection/fix (a programmatic switch, e.g. preselect, can land while
      // a dialog is open). The post gate especially must not survive: its
      // verdict would target the NEW PR's displayed run.
      closeGates();
    },
    [setSelectedPr, setViewingRunId, setReconfiguring, resetFindingUi, closeGates],
  );

  const viewRun = useCallback(
    (runId: string) => {
      resetFindingUi();
      setReconfiguring(false);
      setViewingRunId(runId);
      // Authoritative reload of the persisted run into the registry.
      void selectRun(runId);
    },
    [resetFindingUi, setReconfiguring, setViewingRunId, selectRun],
  );

  const backToLatest = useCallback(() => {
    resetFindingUi();
    setViewingRunId(null);
    setReconfiguring(false);
  }, [resetFindingUi, setViewingRunId, setReconfiguring]);

  const backToResults = useCallback(
    () => setReconfiguring(false),
    [setReconfiguring],
  );

  // Plain per-render projection (MenuItem construction is trivial; the history
  // array itself is already a fresh filter per render inside `byPr`).
  const historyItems: MenuItem[] = prHistory.map((run) => ({
    label: `${new Date(run.createdAt).toLocaleString()} · ${run.findings.length} ${
      run.findings.length === 1 ? 'finding' : 'findings'
    }`,
    onClick: () => viewRun(run.id),
  }));

  // The latest selected PR, readable inside async continuations (a state read
  // there can be a render behind).
  const selectedPrRef = useRef(selectedPr);
  selectedPrRef.current = selectedPr;

  const onReview = useCallback(() => {
    const prNumber = selectedPrRef.current;
    if (prNumber === null) return;
    resetFindingUi();
    setStartingPrs((prev) => new Set(prev).add(prNumber));
    void (async () => {
      try {
        const runId = await start(prNumber, config.orderedSelected, {
          model: config.model,
          effort: config.effort as EffortLevel | null,
        });
        // Leave config only once the run actually starts — a rejected start
        // lands in the per-PR startErrors and config STAYS up so the banner is
        // seen. Skip the flag clears when the user already switched PRs
        // (selectPr reset them; clearing again could collapse the OTHER PR's
        // freshly opened config).
        if (runId !== null && selectedPrRef.current === prNumber) {
          setReconfiguring(false);
          setViewingRunId(null);
        }
      } finally {
        setStartingPrs((prev) => {
          const next = new Set(prev);
          next.delete(prNumber);
          return next;
        });
      }
    })();
  }, [
    resetFindingUi,
    setStartingPrs,
    setReconfiguring,
    setViewingRunId,
    start,
    config.orderedSelected,
    config.model,
    config.effort,
  ]);

  const onCancelRun = useCallback(() => {
    if (runningRunId === null) return;
    void cancel(runningRunId).catch((err: unknown) => {
      console.error('cancel_pr_review failed', err);
      toast.error('Could not cancel the review', err);
    });
  }, [runningRunId, cancel, toast]);

  // Plain closure (config is a fresh object each render, so memoizing over it
  // buys nothing): "New review" re-opens config prefilled from the displayed run.
  const startNewReview = () => {
    config.prefill({
      model: displayStream?.model,
      categories: displayStream?.requestedLenses,
    });
    resetFindingUi();
    setReconfiguring(true);
  };

  // Board→scan provenance navigation: a task's `sourceRef` chip landed here
  // with a run + finding to open. Consume the target FIRST, select the run's
  // PR, project that run's stream, and open the finding's detail panel.
  const preselectRun = useCallback(
    async (runId: string) => {
      const stream = await selectRun(runId);
      if (stream !== null && stream.prNumber !== null) {
        setSelectedPr(stream.prNumber);
        setViewingRunId(runId);
      }
    },
    [selectRun, setSelectedPr, setViewingRunId],
  );
  usePreselectNavigation({
    preselect,
    onPreselectConsumed,
    selectRun: preselectRun,
    onEnter: () => {
      setReconfiguring(false);
      resetFindingUi();
      // Close ALL the human gates, exactly like a manual selectPr — a
      // preselect can land while any of the three dialogs is open against a
      // different PR's run/fix, and this path bypasses selectPr entirely.
      closeGates();
    },
    onOpenItem: (target) => setSelectedId(target.itemId),
  });

  return {
    selectPr,
    viewRun,
    backToLatest,
    backToResults,
    historyItems,
    onReview,
    onCancelRun,
    startNewReview,
  };
}
