/**
 * The selected PR's review-section slice — split out of the PrReviewView
 * mega-hook along its "section slice" concern: the registry projections for the
 * selected PR (display stream, mode, per-row status/counts) and the
 * review-position layer (lifecycle, reconciliation, staleness, timeline,
 * follow-up). Pure derivation over the run registry + fix map + open-PR list;
 * it owns no navigation state and never touches the finding selection or the
 * human gates, so it sits cleanly BEFORE them in the composition.
 */
import { useEffect, useMemo, useState } from 'react';

import type { RunProgressCategory } from '@/components/ui';
import {
  type PrFixState,
  type PrReviewRun,
  type PrSummary,
  type ReviewLens,
  viewerLogin,
} from '@/lib/bridge';
import { seedStepState } from '@/lib/scan-run';
import type { RunConfig } from '@/lib/useRunConfig';

import { LENS_META } from './prreview.constants';
import type { UsePrFixesResult } from './prreview-fixes.hooks';
import {
  compareRuns,
  deriveReviewLifecycle,
  deriveReviewTimeline,
  type FollowupComparison,
  reconcilePostedVerdict,
  type ReviewLifecycle,
  type TimelineStep,
} from './prreview-lifecycle';
import type { OpenPrs } from './prreview-open-prs.hooks';
import {
  findingCountForPr,
  historyForPr,
  latestRunForPr,
  runningPrNumbers,
} from './prreview-runs';
import type { PrRunView, UsePrReviewRunsResult } from './prreview-runs.hooks';
import { EMPTY_REVIEW_STREAM, type ReviewStream } from './prreview-stream';
import type { PrNumberStatusView } from './PrStatusBlock';
import { usePrStatusByNumber } from './PrStatusBlock/PrStatusBlock.hooks';
import type { ReviewSectionMode } from './ReviewSection';

/** The navigation state the section projects against (owned by the composition). */
export interface PrReviewSectionConfig {
  /** The selected PR number, or null (empty right panel). */
  selectedPr: number | null;
  /** A history selection: display THIS run instead of the PR's latest. */
  viewingRunId: string | null;
  /** "New review" over existing results: show config without dropping them. */
  reconfiguring: boolean;
  /** PRs inside the Review-click → optimistic-entry IPC gap (per-PR spinner). */
  startingPrs: ReadonlySet<number>;
  /** The per-PR run registry. */
  runs: UsePrReviewRunsResult;
  /** The per-PR fix registry. */
  fixes: UsePrFixesResult;
  /** The persistent open-PR list (row projections + selected summary). */
  openPrs: OpenPrs;
  /** The lifted lens/model/effort form state (seeds the synthetic running strip). */
  config: RunConfig<ReviewLens>;
}

/** The section slice + review-position layer for the selected PR. */
export interface PrReviewSectionApi {
  prView: PrRunView | null;
  statusView: PrNumberStatusView;
  selectedSummary: PrSummary | null;
  ownPr: boolean;
  mode: ReviewSectionMode;
  isStarting: boolean;
  startError: string | null;
  /** Stream projections (live, display, running). */
  streams: {
    latestStream: ReviewStream | null;
    latestRun: PrReviewRun | null;
    /** The stream the right panel displays (history selection wins, else latest). */
    displayStream: ReviewStream | null;
    displayRunId: string | null;
    /** The persisted run behind the DISPLAYED stream (source of its merge verdict). */
    displayRun: PrReviewRun | null;
    viewingPastRun: boolean;
    /** The stream the RUNNING branch renders (live run or seeded synthetic). */
    runningStream: ReviewStream | null;
    /** The displayed run's id when it is running (drives per-run cancel), else null. */
    runningRunId: string | null;
    runningPrs: readonly number[];
  };
  rowData: {
    prRowStatuses: Readonly<Record<number, ReviewLifecycle>>;
    prFindingCounts: Readonly<Record<number, number>>;
  };
  ui: {
    progressCategories: RunProgressCategory[];
    lensFindingCounts: Record<string, number>;
    emptyMessage: string;
  };
  position: {
    prFix: PrFixState | null;
    lifecycle: ReviewLifecycle | null;
    reconciliation: string[];
    stale: boolean;
    timeline: TimelineStep[];
    followup: FollowupComparison | null;
    fixRunning: boolean;
  };
  targets: {
    /** The displayed run's PR — the post target. */
    postPrNumber: number | null;
    /** The address target (the displayed run's PR, else the selected PR). */
    addressPrNumber: number | null;
    /** This PR's last address rejection (from the fix registry), or null. */
    addressError: string | null;
  };
}

/** Project the selected PR's review-section slice out of the run registry. */
export function usePrReviewSection({
  selectedPr,
  viewingRunId,
  reconfiguring,
  startingPrs,
  runs,
  fixes,
  openPrs,
  config,
}: PrReviewSectionConfig): PrReviewSectionApi {
  const { registry, runs: allRuns, startErrors, byPr } = runs;
  /** The gh viewer login, fetched ONCE per mount. `null` = unknown → the
   *  own-PR guard fails open (all verdicts enabled). */
  const [login, setLogin] = useState<string | null>(null);

  // The viewer login, once per mount. A rejection leaves `null` — fail-open.
  useEffect(() => {
    let cancelled = false;
    viewerLogin().then(
      (l) => {
        // Coerce a void resolution (mock/browser seams) to the null sentinel.
        if (!cancelled) setLogin(l ?? null);
      },
      () => {
        // Swallow: guard intentionally fails open; UI state already handles missing login.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Registry projections for the selected PR --------------------------
  const prView = selectedPr !== null ? byPr(selectedPr) : null;
  // Lift the live GitHub status ONCE for the selected PR (0 → disabled, no
  // fetch when nothing is selected): the workspace status line, the
  // reconciliation banner, and the staleness signal all read this one fetch,
  // and it feeds the status block via the workspace's `statusView` prop.
  const statusView = usePrStatusByNumber(selectedPr ?? 0, undefined, selectedPr !== null);
  const latestStream = prView?.stream ?? null;
  // The PR's newest PERSISTED run (source of postedVerdict / verdict / headSha).
  const latestRun = prView?.history[0] ?? null;
  const viewedStream =
    viewingRunId !== null ? (registry.get(viewingRunId)?.stream ?? null) : null;
  /** The stream the right panel displays: a history selection wins, else the
   *  PR's latest (running-first) stream. */
  const displayStream = viewedStream ?? latestStream;
  const displayRunId = displayStream?.runId ?? null;
  // The persisted run behind the DISPLAYED stream (source of its merge verdict).
  const displayRun =
    displayRunId !== null ? (allRuns.find((r) => r.id === displayRunId) ?? null) : null;
  const viewingPastRun =
    viewingRunId !== null &&
    displayStream !== null &&
    latestStream !== null &&
    displayStream.runId !== latestStream.runId;

  const isStarting = selectedPr !== null && startingPrs.has(selectedPr);
  const startError =
    selectedPr !== null ? (startErrors.get(selectedPr) ?? null) : null;

  const mode: ReviewSectionMode =
    isStarting || displayStream?.status === 'running'
      ? 'running'
      : reconfiguring || displayStream === null
        ? 'config'
        : 'results';

  // The stream the RUNNING branch renders: the live run, or a seeded synthetic
  // one during the Review-click → optimistic-entry IPC gap (so the progress
  // rows lay out immediately, exactly like the old running screen's seed).
  const runningStream: ReviewStream | null = useMemo(() => {
    if (displayStream !== null && displayStream.status === 'running') {
      return displayStream;
    }
    if (!isStarting) return null;
    return {
      ...EMPTY_REVIEW_STREAM,
      status: 'running',
      prNumber: selectedPr,
      model: config.model,
      requestedLenses: config.orderedSelected,
      lensState: seedStepState(config.orderedSelected),
    };
  }, [displayStream, isStarting, selectedPr, config.model, config.orderedSelected]);

  const runningRunId =
    displayStream !== null && displayStream.status === 'running'
      ? displayStream.runId
      : null;

  const runningPrs = useMemo(() => runningPrNumbers(registry), [registry]);

  // Per-PR lifecycle for the list rows (status dot + short label). No live
  // GitHub status per row — only the selected PR is fetched — so staleness never
  // fires here; the registry + persisted runs + fix map are enough.
  const prRowStatuses = useMemo(() => {
    const out: Record<number, ReviewLifecycle> = {};
    for (const pr of openPrs.prs) {
      out[pr.number] = deriveReviewLifecycle({
        stream: latestRunForPr(registry, pr.number),
        latestRun: historyForPr(allRuns, pr.number)[0] ?? null,
        fix: fixes.fixForPr(pr.number),
        prStatus: null,
      });
    }
    return out;
  }, [openPrs.prs, registry, allRuns, fixes.fixForPr]);

  const prFindingCounts = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const pr of openPrs.prs) {
      counts[pr.number] = findingCountForPr(registry, pr.number);
    }
    return counts;
  }, [openPrs.prs, registry]);

  const selectedSummary = useMemo(
    () =>
      selectedPr !== null
        ? (openPrs.prs.find((pr) => pr.number === selectedPr) ?? null)
        : null,
    [openPrs.prs, selectedPr],
  );
  const ownPr =
    login !== null && selectedSummary !== null && selectedSummary.author === login;

  const progressCategories: RunProgressCategory[] = useMemo(
    () =>
      (runningStream?.requestedLenses ?? []).map((l) => ({
        key: l,
        label: LENS_META[l].label,
        icon: LENS_META[l].icon,
      })),
    [runningStream?.requestedLenses],
  );

  const lensFindingCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of runningStream?.findings ?? []) {
      counts[f.lens] = (counts[f.lens] ?? 0) + 1;
    }
    return counts;
  }, [runningStream?.findings]);

  const emptyMessage = useMemo(() => {
    if (displayStream === null) {
      return 'Review this pull request to surface findings across the review lenses.';
    }
    if (displayStream.status === 'running') return 'Reviewing…';
    if (displayStream.status === 'failed') {
      if (displayStream.failureReason === 'aborted') return 'Review cancelled.';
      return `Review failed${
        displayStream.error !== null ? `: ${displayStream.error}` : ''
      }.`;
    }
    return 'No findings — the diff looks clean across the selected lenses.';
  }, [displayStream]);

  // --- Review-position layer (lifecycle + banners) -----------------------
  /** The selected PR's displayed fix (latest by `updatedAt`), or null. */
  const prFix = selectedPr !== null ? fixes.fixForPr(selectedPr) : null;
  // The selected PR's lifecycle for the workspace status line: reviewing wins,
  // then a fix in flight, then (for a completed review) stale > posted > pending.
  const lifecycle: ReviewLifecycle | null =
    selectedPr === null
      ? null
      : deriveReviewLifecycle({
          stream: latestStream,
          latestRun,
          fix: prFix,
          prStatus: statusView.status,
          isStarting,
        });
  // The live-status banners (reconciliation + staleness) speak to the CURRENT
  // head, so they only apply when the displayed run is the PR's latest — a
  // history selection suppresses them.
  const showLivePosition = !viewingPastRun;
  const reconciliation = showLivePosition
    ? reconcilePostedVerdict(latestRun, statusView.status)
    : [];
  const stale = showLivePosition ? (lifecycle?.stale ?? false) : false;
  // The PR's review-arc timeline — a PR-level projection of the latest run + fix
  // (stable across history navigation), unifying History + FixRunCard.
  const timeline = useMemo(
    () => deriveReviewTimeline(latestRun, prFix, stale),
    [latestRun, prFix, stale],
  );
  // Follow-up comparison: the displayed run vs the one immediately before it in
  // this PR's history (latest-vs-previous in the common case), by fingerprint.
  const historyList = prView?.history ?? [];
  const displayHistoryIdx =
    displayRun !== null ? historyList.findIndex((r) => r.id === displayRun.id) : -1;
  const previousRun =
    displayHistoryIdx >= 0 && displayHistoryIdx + 1 < historyList.length
      ? (historyList[displayHistoryIdx + 1] ?? null)
      : null;
  const followup =
    displayRun !== null && displayRun.status === 'completed' && previousRun !== null
      ? compareRuns(displayRun.findings, previousRun.findings)
      : null;
  const fixRunning = prFix !== null && prFix.status === 'running';

  const postPrNumber = displayStream?.prNumber ?? null;
  const addressPrNumber = displayStream?.prNumber ?? selectedPr;
  const addressError =
    selectedPr !== null ? (fixes.fixErrors.get(selectedPr) ?? null) : null;

  return {
    prView,
    statusView,
    selectedSummary,
    ownPr,
    mode,
    isStarting,
    startError,
    streams: {
      latestStream,
      latestRun,
      displayStream,
      displayRunId,
      displayRun,
      viewingPastRun,
      runningStream,
      runningRunId,
      runningPrs,
    },
    rowData: {
      prRowStatuses,
      prFindingCounts,
    },
    ui: {
      progressCategories,
      lensFindingCounts,
      emptyMessage,
    },
    position: {
      prFix,
      lifecycle,
      reconciliation,
      stale,
      timeline,
      followup,
      fixRunning,
    },
    targets: {
      postPrNumber,
      addressPrNumber,
      addressError,
    },
  };
}
