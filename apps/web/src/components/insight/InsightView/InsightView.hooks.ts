/** Hooks that resolve the Insight surface into a single view model: the live and
 *  persisted run stream, the lifted run-config, and every screen's derived state. */
import { useMemo } from 'react';

import type {
  MenuItem,
  RunPhase,
  RunProgressCategory,
} from '@/components/ui';
import { useToast } from '@/components/ui';
import type { FindingCategory } from '@/lib/bridge';
import { formatRunReceipt } from '@/lib/formatters';
import {
  buildLensTabs,
  countByLens,
  countOpenItems,
  deriveRunPhase,
  scanSkeletonCount,
} from '@/lib/scan-run';
import { sortBySeverityThenStatus } from '@/lib/severity';
import { useBulkConvert } from '@/lib/useBulkConvert';
import { usePreselectNavigation } from '@/lib/usePreselectNavigation';
import { useScanResultsView } from '@/lib/useScanResultsView';

import { buildProgressCategories } from '../buildProgressCategories';
import type { CategoryTab } from '../CategoryTabs';
import { ALL_CATEGORIES, CATEGORY_META } from '../insight.constants';
import type { InsightFinding } from '../insight.types';
import type { InsightStream } from '../insight-stream';
import { useRunConfig } from '../RunControls/RunControls.hooks';
import type { InsightRunConfig } from '../RunControls/RunControls.types';
import { useInsight } from './hooks/useInsight.hooks';
import type { InsightViewProps } from './InsightView.types';

/** Everything the InsightView shell renders. `hasProject === false` is the only
 *  early-return branch; every other field is meaningful in the project view. */
export interface InsightViewModel {
  hasProject: boolean;
  projectName: string | null;
  stream: InsightStream;
  /** Which lifecycle screen (CONFIGURE / RUNNING / RESULTS) is active. */
  phase: RunPhase;
  /** The lifted run-config form state, passed straight into RunControls. */
  config: InsightRunConfig;
  /** The collapsed-config summary string for the shell's summary bar. */
  summary: string;
  isStarting: boolean;
  startError: string | null;
  /** Run-history menu entries (newest first), each selecting that run. */
  runHistory: MenuItem[];
  /** Whether to surface the history affordance (≥1 persisted run). */
  hasHistory: boolean;
  /** RunProgress: the requested lenses as ordered category descriptors. */
  progressCategories: RunProgressCategory[];
  /** RunProgress: total findings produced per category so far. */
  findingCounts: Record<string, number>;
  tabs: CategoryTab[];
  activeTab: 'all' | FindingCategory;
  setActiveTab: (key: 'all' | FindingCategory) => void;
  gridFindings: InsightFinding[];
  skeletonCount: number;
  emptyMessage: string;
  /** The finding open in the detail panel, or `null`. */
  selected: InsightFinding | null;
  openFinding: (finding: InsightFinding) => void;
  closeFinding: () => void;
  /** True while a finding action (convert/dismiss/restore) is in flight. */
  pending: boolean;
  onAnalyze: () => void;
  onCancel: () => void;
  /** RUNNING partial-reveal: peek a finished category while others run. */
  peekCategory: FindingCategory | null;
  peekLabel: string | null;
  peekFindings: InsightFinding[];
  onOpenCategory: (key: string) => void;
  clearPeek: () => void;
  /** "New run" / "Retry": back to CONFIGURE, pre-filled from the last run. */
  startNewRun: () => void;
  /** Bulk convert: open, not-yet-converted findings → tasks (idempotent). */
  convertAll: () => void;
  bulkConverting: boolean;
  bulkProgress: { done: number; total: number; failed: number };
  /** Polite aria-live announcement for the convert-all flow ('' when idle). */
  bulkStatusMessage: string;
  /** Inline failure summary when conversions rejected mid-loop, else `null`. */
  bulkError: string | null;
  /** Count of open (convertible) findings in the current run. */
  openCount: number;
  onConvert: (findingId: string) => void;
  onDismiss: (findingId: string) => void;
  onRestore: (findingId: string) => void;
  onGotoBoard?: () => void;
}

/** Resolve the entire Insight surface into a single view model: the live/persisted
 *  stream (via `useInsight`), the lifted run-config form, the derived lifecycle
 *  `phase`, and every screen's derived lists (tabs, sorted grid findings, progress
 *  rows, peek state, bulk-convert progress). The component shell renders purely
 *  from this. */
export function useInsightView({
  projectPath,
  projectName,
  onGotoBoard,
  preselect,
  onPreselectConsumed,
}: InsightViewProps): InsightViewModel {
  const hasProject = projectPath !== null;
  const toast = useToast();
  const insight = useInsight(hasProject);
  const { stream } = insight;

  // Lifted run-config form state — lives above RunControls so it survives the
  // CONFIGURE → RUNNING → RESULTS phase swaps and pre-fills on "New run".
  const config = useRunConfig(!hasProject);

  // The shared results-view cluster: tab / selection / pending+runAction /
  // reconfigure / peek.
  const view = useScanResultsView<FindingCategory>({
    notifyError: (title, err) => toast.error(title, err),
  });
  const { activeTab, setSelectedId, resetTransient, runAction } = view;
  // Bulk convert-all progress + loop (shared with the PR-Review sibling).
  const { resetBulk, convertAll, bulkConverting, bulkProgress, bulkStatusMessage, bulkError } =
    useBulkConvert(insight.convert, 'convertFindingToTask failed');

  // Board→scan provenance navigation: a task's `sourceRef` chip landed here with
  // a run + finding to open. Consume the target FIRST, land on that run's RESULTS,
  // and open the finding's detail panel.
  usePreselectNavigation({
    preselect,
    onPreselectConsumed,
    selectRun: insight.selectRun,
    onEnter: () => {
      resetTransient();
      resetBulk();
      view.setActiveTab('all');
    },
    onOpenItem: (target) => setSelectedId(target.itemId),
  });

  const phase: RunPhase = deriveRunPhase(stream.status, insight.isStarting, view.reconfiguring);

  const tabs: CategoryTab[] = useMemo(
    () =>
      buildLensTabs({
        all: ALL_CATEGORIES,
        requested: stream.requestedCategories,
        stepState: stream.categoryState,
        items: stream.findings,
        lensOf: (f) => f.category,
      }),
    [stream.requestedCategories, stream.categoryState, stream.findings],
  );

  const gridFindings = useMemo(() => {
    const filtered =
      activeTab === 'all'
        ? stream.findings
        : stream.findings.filter((f) => f.category === activeTab);
    return sortBySeverityThenStatus(filtered);
  }, [stream.findings, activeTab]);

  const skeletonCount = useMemo(
    () => scanSkeletonCount(stream.status, stream.categoryState, activeTab),
    [stream.status, stream.categoryState, activeTab],
  );

  const selected = useMemo(
    () => stream.findings.find((f) => f.id === view.selectedId) ?? null,
    [stream.findings, view.selectedId],
  );

  const progressCategories: RunProgressCategory[] = useMemo(
    () => buildProgressCategories(stream.requestedCategories),
    [stream.requestedCategories],
  );

  const findingCounts = useMemo(
    () => countByLens(stream.findings, (f) => f.category),
    [stream.findings],
  );

  const peekFindings = useMemo(() => {
    if (view.peekLens === null) return [];
    return sortBySeverityThenStatus(
      stream.findings.filter((f) => f.category === view.peekLens),
    );
  }, [stream.findings, view.peekLens]);

  const summary = useMemo(() => {
    const n = stream.requestedCategories.length;
    const parts = [
      stream.model ?? 'default',
      ...(config.effort != null ? [config.effort] : []),
      stream.scope ?? 'repo',
      `${n} ${n === 1 ? 'category' : 'categories'}`,
    ];
    return `⌖ ${parts.join(' · ')}`;
  }, [stream.model, stream.scope, stream.requestedCategories, config.effort]);

  const runHistory: MenuItem[] = useMemo(
    () =>
      insight.runs.map((run) => ({
        label: `${new Date(run.createdAt).toLocaleString()} · ${run.findings.length} findings · ${formatRunReceipt(run.costUsd, run.durationMs)}`,
        onClick: () => {
          // Selecting a past run lands on its RESULTS — drop any reconfigure/peek
          // first, else the derived phase stays on CONFIGURE (reconfiguring=true).
          resetTransient();
          resetBulk();
          void insight.selectRun(run.id);
        },
      })),
    [insight, resetTransient, resetBulk],
  );

  const emptyMessage = useMemo(() => {
    if (stream.status === 'idle') {
      return 'Run an analysis to surface findings across your codebase.';
    }
    if (stream.status === 'running') return 'Analyzing…';
    if (stream.status === 'failed') {
      if (stream.failureReason === 'aborted') return 'Analysis cancelled.';
      return `Analysis failed${stream.error !== null ? `: ${stream.error}` : ''}.`;
    }
    return 'No findings in this category — a clean bill of health.';
  }, [stream.status, stream.error, stream.failureReason]);

  return {
    hasProject,
    projectName,
    stream,
    phase,
    config,
    summary,
    isStarting: insight.isStarting,
    startError: insight.startError,
    runHistory,
    hasHistory: insight.runs.length > 0,
    progressCategories,
    findingCounts,
    tabs,
    activeTab,
    setActiveTab: view.setActiveTab,
    gridFindings,
    skeletonCount,
    emptyMessage,
    selected,
    openFinding: (finding: InsightFinding) => setSelectedId(finding.id),
    closeFinding: () => setSelectedId(null),
    pending: view.pending,
    onAnalyze: () => {
      resetTransient();
      // Clear any prior convert-all summary so it can't bleed into the next run.
      resetBulk();
      void insight.start(
        config.scope,
        config.orderedSelected,
        config.model,
        config.effort,
        config.providerId,
      );
    },
    onCancel: () => void insight.cancel(),
    peekCategory: view.peekLens,
    peekLabel: view.peekLens !== null ? CATEGORY_META[view.peekLens].label : null,
    peekFindings,
    onOpenCategory: (key: string) => view.openPeek(key as FindingCategory),
    clearPeek: view.clearPeek,
    startNewRun: () => {
      config.prefill({
        scope: stream.scope,
        model: stream.model,
        categories: stream.requestedCategories,
      });
      view.startReconfigure();
    },
    convertAll: () => convertAll(stream.findings.filter((f) => f.status === 'open')),
    bulkConverting,
    bulkProgress,
    bulkStatusMessage,
    bulkError,
    openCount: countOpenItems(stream.findings),
    onConvert: (id) => void runAction('convert finding', () => insight.convert(id)),
    onDismiss: (id) => void runAction('dismiss finding', () => insight.dismiss(id)),
    onRestore: (id) => void runAction('restore finding', () => insight.restore(id)),
    onGotoBoard,
  };
}
