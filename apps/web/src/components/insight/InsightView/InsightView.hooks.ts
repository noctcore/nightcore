/** Hooks that resolve the Insight surface into a single view model: the live and
 *  persisted run stream, the lifted run-config, and every screen's derived state. */
import { useCallback, useMemo, useState } from 'react';

import type {
  MenuItem,
  RunPhase,
  RunProgressCategory,
} from '@/components/ui';
import { useToast } from '@/components/ui';
import {
  type AnalysisScope,
  cancelAnalysis,
  convertFindingToTask,
  dismissFinding,
  type EffortLevel,
  type FindingCategory,
  getInsightRun,
  type InsightEvent,
  type InsightRun,
  listInsightRuns,
  onInsightEvent,
  restoreFinding,
  startAnalysis,
  type Task,
} from '@/lib/bridge';
import { deriveRunPhase, seedStepState } from '@/lib/scan-run';
import { useBulkConvert } from '@/lib/useBulkConvert';
import { usePreselectNavigation } from '@/lib/usePreselectNavigation';
import { useScanRun } from '@/lib/useScanRun';

import type { CategoryTab } from '../CategoryTabs';
import { ALL_CATEGORIES, CATEGORY_META, severityRankValue } from '../insight.constants';
import type { InsightFinding } from '../insight.types';
import {
  type CategoryProgress,
  EMPTY_INSIGHT_STREAM,
  foldInsight,
  type InsightStream,
  streamFromRun,
} from '../insight-stream';
import { useRunConfig } from '../RunControls/RunControls.hooks';
import type { InsightRunConfig } from '../RunControls/RunControls.types';
import type { InsightViewProps } from './InsightView.types';

export interface UseInsightResult {
  stream: InsightStream;
  runs: InsightRun[];
  isStarting: boolean;
  startError: string | null;
  start: (
    scope: AnalysisScope,
    categories: FindingCategory[],
    model: string | null,
    effort: string | null,
  ) => Promise<void>;
  cancel: () => Promise<void>;
  selectRun: (runId: string) => Promise<void>;
  dismiss: (findingId: string) => Promise<void>;
  restore: (findingId: string) => Promise<void>;
  convert: (findingId: string) => Promise<Task | null>;
}

/** Drive the Insight view: live `analysis-*` fold for the active run, authoritative
 *  reconciliation against the persisted run on completion, and finding actions. */
export function useInsight(hasProject: boolean): UseInsightResult {
  const scan = useScanRun<InsightEvent, InsightRun, InsightStream>({
    emptyStream: EMPTY_INSIGHT_STREAM,
    listRuns: listInsightRuns,
    getRun: getInsightRun,
    streamFromRun,
    cancelRun: cancelAnalysis,
    subscribe: onInsightEvent,
    onEvent: (event, { activeRunId, setStream, refreshRuns, reconcile }) => {
      if (event.type === 'finding-converted') {
        setStream((prev) =>
          prev.runId === event.runId
            ? {
                ...prev,
                findings: prev.findings.map((f) =>
                  f.id === event.findingId
                    ? { ...f, status: 'converted', linkedTaskId: event.taskId }
                    : f,
                ),
              }
            : prev,
        );
        void refreshRuns();
        return;
      }
      // analysis-* events only apply to the run currently displayed/driven.
      if (event.runId !== activeRunId.current) return;
      setStream((prev) => foldInsight(prev, event));
      if (event.type === 'analysis-completed' || event.type === 'analysis-failed') {
        void reconcile(event.runId);
      }
    },
  });
  const { stream, setStream, runStart, refreshRuns } = scan;

  const start = useCallback(
    async (
      scope: AnalysisScope,
      categories: FindingCategory[],
      model: string | null,
      effort: string | null,
    ) => {
      await runStart(hasProject && categories.length > 0, async () => {
        const runId = await startAnalysis(scope, categories, {
          model,
          effort: effort as EffortLevel | null,
        });
        // Optimistic running state until `analysis-started` lands.
        return {
          runId,
          optimistic: {
            ...EMPTY_INSIGHT_STREAM,
            runId,
            status: 'running',
            scope,
            model,
            requestedCategories: categories,
            categoryState: seedStepState(categories),
          },
        };
      });
    },
    [hasProject, runStart],
  );

  const dismiss = useCallback(
    async (findingId: string) => {
      if (stream.runId === null) return;
      const run = await dismissFinding(stream.runId, findingId);
      if (run !== null) setStream(streamFromRun(run));
      await refreshRuns();
    },
    [stream.runId, setStream, refreshRuns],
  );

  const restore = useCallback(
    async (findingId: string) => {
      if (stream.runId === null) return;
      const run = await restoreFinding(stream.runId, findingId);
      if (run !== null) setStream(streamFromRun(run));
      await refreshRuns();
    },
    [stream.runId, setStream, refreshRuns],
  );

  const convert = useCallback(
    async (findingId: string): Promise<Task | null> => {
      if (stream.runId === null) return null;
      const task = await convertFindingToTask(stream.runId, findingId);
      setStream((prev) => ({
        ...prev,
        findings: prev.findings.map((f) =>
          f.id === findingId
            ? { ...f, status: 'converted', linkedTaskId: task.id }
            : f,
        ),
      }));
      await refreshRuns();
      return task;
    },
    [stream.runId, setStream, refreshRuns],
  );

  return {
    stream,
    runs: scan.runs,
    isStarting: scan.isStarting,
    startError: scan.startError,
    start,
    cancel: scan.cancel,
    selectRun: scan.selectRun,
    dismiss,
    restore,
    convert,
  };
}

const RUNNING: CategoryProgress = 'running';

/** Order findings for display: open before resolved, then severity (high→low). */
function sortFindings(findings: InsightFinding[]): InsightFinding[] {
  const statusRank = (f: InsightFinding) => (f.status === 'open' ? 0 : 1);
  return [...findings].sort((a, b) => {
    const s = statusRank(a) - statusRank(b);
    if (s !== 0) return s;
    return severityRankValue(b.severity) - severityRankValue(a.severity);
  });
}

/** Categories that appear as tabs: those requested this run plus any that produced
 *  findings (covers loading a past run whose requested set we project from). */
function tabCategories(stream: InsightStream): FindingCategory[] {
  const present = new Set<FindingCategory>(stream.requestedCategories);
  for (const f of stream.findings) present.add(f.category);
  return ALL_CATEGORIES.filter((c) => present.has(c));
}

function openCount(findings: InsightFinding[], category?: FindingCategory): number {
  return findings.filter(
    (f) =>
      f.status === 'open' && (category === undefined || f.category === category),
  ).length;
}

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

  const [activeTab, setActiveTab] = useState<'all' | FindingCategory>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Explicit "New run" override so RESULTS can return to CONFIGURE without
  // discarding the persisted run.
  const [reconfiguring, setReconfiguring] = useState(false);
  // RUNNING partial-reveal: the finished category currently peeked, if any.
  const [peekCategory, setPeekCategory] = useState<FindingCategory | null>(null);
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
      setReconfiguring(false);
      setPeekCategory(null);
      resetBulk();
      setActiveTab('all');
    },
    onOpenItem: (target) => setSelectedId(target.itemId),
  });

  const phase: RunPhase = deriveRunPhase(stream.status, insight.isStarting, reconfiguring);

  const visibleCategories = useMemo(() => tabCategories(stream), [stream]);

  const tabs: CategoryTab[] = useMemo(() => {
    const runningCount = Object.values(stream.categoryState).filter(
      (s) => s === RUNNING,
    ).length;
    const head: CategoryTab = {
      key: 'all',
      count: openCount(stream.findings),
      running: runningCount > 0,
      errored: false,
    };
    return [
      head,
      ...visibleCategories.map((c) => ({
        key: c,
        count: openCount(stream.findings, c),
        running: stream.categoryState[c] === RUNNING,
        errored: stream.categoryState[c] === 'error',
      })),
    ];
  }, [stream, visibleCategories]);

  const gridFindings = useMemo(() => {
    const filtered =
      activeTab === 'all'
        ? stream.findings
        : stream.findings.filter((f) => f.category === activeTab);
    return sortFindings(filtered);
  }, [stream.findings, activeTab]);

  const skeletonCount = useMemo(() => {
    if (stream.status !== 'running') return 0;
    if (activeTab === 'all') {
      const running = Object.values(stream.categoryState).filter(
        (s) => s === RUNNING,
      ).length;
      return Math.min(6, running * 2);
    }
    return stream.categoryState[activeTab] === RUNNING ? 3 : 0;
  }, [stream.status, stream.categoryState, activeTab]);

  const selected = useMemo(
    () => stream.findings.find((f) => f.id === selectedId) ?? null,
    [stream.findings, selectedId],
  );

  // RunProgress feed: requested lenses → ordered descriptors + per-lens counts.
  const progressCategories: RunProgressCategory[] = useMemo(
    () =>
      stream.requestedCategories.map((c) => ({
        key: c,
        label: CATEGORY_META[c].label,
        icon: CATEGORY_META[c].icon,
      })),
    [stream.requestedCategories],
  );

  const findingCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of stream.findings) {
      counts[f.category] = (counts[f.category] ?? 0) + 1;
    }
    return counts;
  }, [stream.findings]);

  const peekFindings = useMemo(() => {
    if (peekCategory === null) return [];
    return sortFindings(stream.findings.filter((f) => f.category === peekCategory));
  }, [stream.findings, peekCategory]);

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
        label: `${new Date(run.createdAt).toLocaleString()} · ${run.findings.length} findings`,
        onClick: () => {
          // Selecting a past run lands on its RESULTS — drop any reconfigure/peek
          // first, else the derived phase stays on CONFIGURE (reconfiguring=true).
          setReconfiguring(false);
          setPeekCategory(null);
          resetBulk();
          void insight.selectRun(run.id);
        },
      })),
    [insight, resetBulk],
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

  const runAction = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setPending(true);
      try {
        await fn();
      } catch (err) {
        // Callers fire this as `void runAction(...)`, so without this catch a failed
        // convert/dismiss/restore would only clear `pending` and vanish — no toast,
        // no inline error, the card silently unchanged (and the rejection escaping as
        // an unhandled promise rejection). Surface it through the toast channel that
        // every routed `invoke` failure already uses.
        console.error(`${label} finding failed`, err);
        toast.error(`Could not ${label} finding`, err);
      } finally {
        setPending(false);
      }
    },
    [toast],
  );

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
    setActiveTab,
    gridFindings,
    skeletonCount,
    emptyMessage,
    selected,
    openFinding: (finding: InsightFinding) => setSelectedId(finding.id),
    closeFinding: () => setSelectedId(null),
    pending,
    onAnalyze: () => {
      setReconfiguring(false);
      setPeekCategory(null);
      // Clear any prior convert-all summary so it can't bleed into the next run.
      resetBulk();
      void insight.start(
        config.scope,
        config.orderedSelected,
        config.model,
        config.effort,
      );
    },
    onCancel: () => void insight.cancel(),
    peekCategory,
    peekLabel: peekCategory !== null ? CATEGORY_META[peekCategory].label : null,
    peekFindings,
    onOpenCategory: (key: string) => setPeekCategory(key as FindingCategory),
    clearPeek: () => setPeekCategory(null),
    startNewRun: () => {
      config.prefill({
        scope: stream.scope,
        model: stream.model,
        categories: stream.requestedCategories,
      });
      setPeekCategory(null);
      setReconfiguring(true);
    },
    convertAll: () => convertAll(stream.findings.filter((f) => f.status === 'open')),
    bulkConverting,
    bulkProgress,
    bulkStatusMessage,
    bulkError,
    openCount: openCount(stream.findings),
    onConvert: (id) => void runAction('convert', () => insight.convert(id)),
    onDismiss: (id) => void runAction('dismiss', () => insight.dismiss(id)),
    onRestore: (id) => void runAction('restore', () => insight.restore(id)),
    onGotoBoard,
  };
}
