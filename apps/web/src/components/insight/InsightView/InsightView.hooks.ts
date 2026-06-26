import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MenuItem } from '@/components/ui';
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
import { ALL_CATEGORIES, severityRankValue } from '../insight.constants';
import type { InsightFinding } from '../insight.types';
import {
  EMPTY_INSIGHT_STREAM,
  foldInsight,
  streamFromRun,
  type CategoryProgress,
  type InsightStream,
} from '../insight-stream';
import type { CategoryTab } from '../CategoryTabs';
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
  isStarting: boolean;
  startError: string | null;
  /** Run-history menu entries (newest first), each selecting that run. */
  runHistory: MenuItem[];
  /** Whether to surface the history affordance (≥1 persisted run). */
  hasHistory: boolean;
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
  onAnalyze: (
    scope: AnalysisScope,
    categories: FindingCategory[],
    model: string | null,
    effort: string | null,
  ) => void;
  onCancel: () => void;
  onConvert: (findingId: string) => void;
  onDismiss: (findingId: string) => void;
  onRestore: (findingId: string) => void;
  onGotoBoard?: () => void;
}

/** Resolve the entire Insight surface into a single view model: the live/persisted
 *  stream (via `useInsight`), the active tab + selected finding UI state, and every
 *  derived list (visible categories, tabs, sorted grid findings, streaming skeleton
 *  count, empty message). The component shell renders purely from this. */
export function useInsightView({
  projectPath,
  projectName,
  onGotoBoard,
}: InsightViewProps): InsightViewModel {
  const hasProject = projectPath !== null;
  const insight = useInsight(hasProject);
  const { stream } = insight;

  const [activeTab, setActiveTab] = useState<'all' | FindingCategory>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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

  const runHistory: MenuItem[] = useMemo(
    () =>
      insight.runs.map((run) => ({
        label: `${new Date(run.createdAt).toLocaleString()} · ${run.findings.length} findings`,
        onClick: () => void insight.selectRun(run.id),
      })),
    [insight],
  );

  const emptyMessage = useMemo(() => {
    if (stream.status === 'idle') {
      return 'Run an analysis to surface findings across your codebase.';
    }
    if (stream.status === 'running') return 'Analyzing…';
    if (stream.status === 'failed') {
      return `Analysis failed${stream.error !== null ? `: ${stream.error}` : ''}.`;
    }
    return 'No findings in this category — a clean bill of health.';
  }, [stream.status, stream.error]);

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
    isStarting: insight.isStarting,
    startError: insight.startError,
    runHistory,
    hasHistory: insight.runs.length > 0,
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
    onAnalyze: (scope, categories, model, effort) =>
      void insight.start(scope, categories, model, effort),
    onCancel: () => void insight.cancel(),
    onConvert: (id) => void runAction(() => insight.convert(id)),
    onDismiss: (id) => void runAction(() => insight.dismiss(id)),
    onRestore: (id) => void runAction(() => insight.restore(id)),
    onGotoBoard,
  };
}
