import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MenuItem,
  RunPhase,
  RunProgressCategory,
} from '@/components/ui';
import {
  cancelAnalysis,
  convertFindingToTask,
  dismissFinding,
  getInsightRun,
  listInsightRuns,
  onInsightEvent,
  restoreFinding,
  startAnalysis,
  type AnalysisScope,
  type EffortLevel,
  type FindingCategory,
  type InsightEvent,
  type InsightRun,
  type Task,
} from '@/lib/bridge';
import { ALL_CATEGORIES, CATEGORY_META, severityRankValue } from '../insight.constants';
import type { InsightFinding } from '../insight.types';
import {
  EMPTY_INSIGHT_STREAM,
  foldInsight,
  streamFromRun,
  type CategoryProgress,
  type InsightStream,
} from '../insight-stream';
import type { CategoryTab } from '../CategoryTabs';
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
  const [stream, setStream] = useState<InsightStream>(EMPTY_INSIGHT_STREAM);
  const [runs, setRuns] = useState<InsightRun[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // The run the live event stream is folded into. A ref so the once-installed
  // listener always reads the latest without re-subscribing.
  const activeRunId = useRef<string | null>(null);
  // Synchronous re-entrancy guard for `start`: blocks a second dispatch in the
  // render-timing gap before the disabled Analyze button / optimistic running
  // state lands, so two fast clicks can't mint two uuids and launch two paid runs.
  const analysisInFlight = useRef(false);

  const refreshRuns = useCallback(async () => {
    const next = await listInsightRuns();
    setRuns(next);
    return next;
  }, []);

  const reconcile = useCallback(async (runId: string) => {
    const run = await getInsightRun(runId);
    if (run !== null) setStream(streamFromRun(run));
    await refreshRuns();
  }, [refreshRuns]);

  // Initial load: list runs and display the newest (already sorted newest-first).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await refreshRuns();
      if (cancelled || next.length === 0) return;
      const newest = next[0];
      if (newest === undefined) return;
      activeRunId.current = newest.id;
      setStream(streamFromRun(newest));
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshRuns]);

  // Subscribe to the live insight stream once.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      const fn = await onInsightEvent((event: InsightEvent) => {
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
      });
      if (disposed) fn();
      else unlisten = fn;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reconcile, refreshRuns]);

  const start = useCallback(
    async (
      scope: AnalysisScope,
      categories: FindingCategory[],
      model: string | null,
      effort: string | null,
    ) => {
      if (!hasProject || categories.length === 0) return;
      // Set synchronously, before the first await: a second click that slips
      // through the render gap before `isStarting`/the optimistic running state
      // disables Analyze is a no-op instead of a second paid run.
      if (analysisInFlight.current) return;
      analysisInFlight.current = true;
      setIsStarting(true);
      setStartError(null);
      try {
        const runId = await startAnalysis(scope, categories, {
          model,
          effort: effort as EffortLevel | null,
        });
        activeRunId.current = runId;
        // Optimistic running state until `analysis-started` lands.
        setStream({
          ...EMPTY_INSIGHT_STREAM,
          runId,
          status: 'running',
          scope,
          model,
          requestedCategories: categories,
          categoryState: Object.fromEntries(
            categories.map((c) => [c, 'pending' as const]),
          ),
        });
        await refreshRuns();
      } catch (err) {
        setStartError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsStarting(false);
        analysisInFlight.current = false;
      }
    },
    [hasProject, refreshRuns],
  );

  const cancel = useCallback(async () => {
    if (stream.runId === null) return;
    await cancelAnalysis(stream.runId);
  }, [stream.runId]);

  const selectRun = useCallback(async (runId: string) => {
    const run = await getInsightRun(runId);
    if (run === null) return;
    activeRunId.current = runId;
    setStream(streamFromRun(run));
  }, []);

  const dismiss = useCallback(
    async (findingId: string) => {
      if (stream.runId === null) return;
      const run = await dismissFinding(stream.runId, findingId);
      if (run !== null) setStream(streamFromRun(run));
      await refreshRuns();
    },
    [stream.runId, refreshRuns],
  );

  const restore = useCallback(
    async (findingId: string) => {
      if (stream.runId === null) return;
      const run = await restoreFinding(stream.runId, findingId);
      if (run !== null) setStream(streamFromRun(run));
      await refreshRuns();
    },
    [stream.runId, refreshRuns],
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
    [stream.runId, refreshRuns],
  );

  return {
    stream,
    runs,
    isStarting,
    startError,
    start,
    cancel,
    selectRun,
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
}: InsightViewProps): InsightViewModel {
  const hasProject = projectPath !== null;
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
  // Bulk convert-all progress. `bulkFailed` collects per-finding convert
  // rejections so the loop continues and surfaces a "converted k, m failed"
  // summary instead of aborting silently.
  const [bulkConverting, setBulkConverting] = useState(false);
  const [bulkTotal, setBulkTotal] = useState(0);
  const [bulkDone, setBulkDone] = useState(0);
  const [bulkFailed, setBulkFailed] = useState(0);
  // Synchronous re-entrancy guard for convert-all: a sub-frame double-click can't
  // launch two concurrent conversion loops (which would double-count progress).
  const convertAllInFlight = useRef(false);

  // Clear the convert-all counters so a prior run's "Converted k/N" summary can't
  // bleed into a freshly entered results view (a new analysis or a history select).
  const resetBulk = useCallback(() => {
    setBulkTotal(0);
    setBulkDone(0);
    setBulkFailed(0);
  }, []);

  // `isStarting` is folded into the phase so the optimistic-running IPC gap shows
  // the RUNNING screen, not a flash of the previous run's RESULTS (the persisted
  // `stream.status` is still `completed` until the optimistic running stream lands).
  const phase: RunPhase =
    stream.status === 'running' || insight.isStarting
      ? 'running'
      : reconfiguring || stream.status === 'idle'
        ? 'configure'
        : 'results';

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

  // Convert-all live announcement (aria-live region) — "Converting k/N" while in
  // flight, then a terminal "Converted N findings (M failed)" once it settles.
  const bulkStatusMessage = useMemo(() => {
    if (bulkConverting) return `Converting ${bulkDone + bulkFailed}/${bulkTotal}…`;
    if (bulkTotal === 0) return '';
    const ok = `Converted ${bulkDone} ${bulkDone === 1 ? 'finding' : 'findings'}`;
    return bulkFailed > 0 ? `${ok} (${bulkFailed} failed).` : `${ok}.`;
  }, [bulkConverting, bulkDone, bulkFailed, bulkTotal]);

  // Inline (visible) failure summary surfaced in the results toolbar when one or
  // more conversions rejected mid-loop.
  const bulkError = useMemo(() => {
    if (bulkConverting || bulkFailed === 0) return null;
    return `${bulkFailed} of ${bulkTotal} ${
      bulkTotal === 1 ? 'finding' : 'findings'
    } could not be converted.`;
  }, [bulkConverting, bulkFailed, bulkTotal]);

  const runAction = useCallback(async (fn: () => Promise<unknown>) => {
    setPending(true);
    try {
      await fn();
    } finally {
      setPending(false);
    }
  }, []);

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
    convertAll: () => {
      // Synchronous ref guard (not the async `bulkConverting` state) so a sub-frame
      // double-click can't start a second concurrent conversion loop.
      if (convertAllInFlight.current) return;
      const targets = stream.findings.filter((f) => f.status === 'open');
      if (targets.length === 0) return;
      convertAllInFlight.current = true;
      setBulkTotal(targets.length);
      setBulkDone(0);
      setBulkFailed(0);
      setBulkConverting(true);
      void (async () => {
        try {
          for (const f of targets) {
            try {
              await insight.convert(f.id);
              setBulkDone((n) => n + 1);
            } catch (err) {
              // One finding's convert rejected — record it and keep going so the
              // rest still convert. Without this catch the loop would abort AND the
              // rejection would escape as an unhandled promise rejection.
              console.error('convertFindingToTask failed', err);
              setBulkFailed((n) => n + 1);
            }
          }
        } finally {
          setBulkConverting(false);
          convertAllInFlight.current = false;
        }
      })();
    },
    bulkConverting,
    bulkProgress: { done: bulkDone, total: bulkTotal, failed: bulkFailed },
    bulkStatusMessage,
    bulkError,
    openCount: openCount(stream.findings),
    onConvert: (id) => void runAction(() => insight.convert(id)),
    onDismiss: (id) => void runAction(() => insight.dismiss(id)),
    onRestore: (id) => void runAction(() => insight.restore(id)),
    onGotoBoard,
  };
}
