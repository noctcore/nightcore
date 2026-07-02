import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  MenuItem,
  RunPhase,
  RunProgressCategory,
} from '@/components/ui';
import { useToast } from '@/components/ui';
import {
  cancelScorecard,
  convertReadingToTask,
  type EffortLevel,
  getScorecardRun,
  listScorecardRuns,
  onScorecardEvent,
  type ScorecardDimension,
  type ScorecardEvent,
  type ScorecardRun,
  startScorecard,
  type Task,
} from '@/lib/bridge';

import type { DimensionRow } from '../DimensionGrid';
import { useRunConfig } from '../RunControls/RunControls.hooks';
import type { ScorecardRunConfig } from '../RunControls/RunControls.types';
import { DIMENSION_META, gradeRankValue } from '../scorecard.constants';
import type { ScorecardReadingView } from '../scorecard.types';
import {
  type DimensionProgress,
  EMPTY_SCORECARD_STREAM,
  foldScorecard,
  type ScorecardStream,
  streamFromRun,
} from '../scorecard-stream';
import type { ScorecardViewProps } from './ScorecardView.types';

interface UseScorecardResult {
  stream: ScorecardStream;
  runs: ScorecardRun[];
  isStarting: boolean;
  startError: string | null;
  start: (
    dimensions: ScorecardDimension[],
    model: string | null,
    effort: string | null,
  ) => Promise<void>;
  cancel: () => Promise<void>;
  selectRun: (runId: string) => Promise<void>;
  harden: (readingId: string) => Promise<Task | null>;
}

/** Drive the Scorecard data layer: live `scorecard-*` fold for the active run,
 *  authoritative reconciliation against the persisted run on completion, and the
 *  harden action. The Profile twin of `useInsight`, minus dismiss/restore. */
function useScorecard(hasProject: boolean): UseScorecardResult {
  const [stream, setStream] = useState<ScorecardStream>(EMPTY_SCORECARD_STREAM);
  const [runs, setRuns] = useState<ScorecardRun[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const activeRunId = useRef<string | null>(null);
  // Synchronous re-entrancy guard for `start`: blocks a second dispatch in the
  // render-timing gap before the disabled Grade button / optimistic running state
  // lands, so two fast clicks can't mint two uuids and launch two paid runs.
  const gradeInFlight = useRef(false);

  const refreshRuns = useCallback(async () => {
    const next = await listScorecardRuns();
    setRuns(next);
    return next;
  }, []);

  const reconcile = useCallback(
    async (runId: string) => {
      const run = await getScorecardRun(runId);
      if (run !== null) setStream(streamFromRun(run));
      await refreshRuns();
    },
    [refreshRuns],
  );

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

  // Subscribe to the live scorecard stream once.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      const fn = await onScorecardEvent((event: ScorecardEvent) => {
        if (event.type === 'reading-converted') {
          setStream((prev) =>
            prev.runId === event.runId
              ? {
                  ...prev,
                  readings: prev.readings.map((r) =>
                    r.id === event.readingId
                      ? { ...r, status: 'converted', linkedTaskId: event.taskId }
                      : r,
                  ),
                }
              : prev,
          );
          void refreshRuns();
          return;
        }
        // scorecard-* events only apply to the run currently displayed/driven.
        if (event.runId !== activeRunId.current) return;
        setStream((prev) => foldScorecard(prev, event));
        if (event.type === 'scorecard-completed' || event.type === 'scorecard-failed') {
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
      dimensions: ScorecardDimension[],
      model: string | null,
      effort: string | null,
    ) => {
      if (!hasProject || dimensions.length === 0) return;
      if (gradeInFlight.current) return;
      gradeInFlight.current = true;
      setIsStarting(true);
      setStartError(null);
      try {
        const runId = await startScorecard(dimensions, {
          model,
          effort: effort as EffortLevel | null,
        });
        activeRunId.current = runId;
        setStream({
          ...EMPTY_SCORECARD_STREAM,
          runId,
          status: 'running',
          model,
          requestedDimensions: dimensions,
          dimensionState: Object.fromEntries(
            dimensions.map((d) => [d, 'pending' as DimensionProgress]),
          ),
        });
        await refreshRuns();
      } catch (err) {
        setStartError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsStarting(false);
        gradeInFlight.current = false;
      }
    },
    [hasProject, refreshRuns],
  );

  const cancel = useCallback(async () => {
    if (stream.runId === null) return;
    await cancelScorecard(stream.runId);
  }, [stream.runId]);

  const selectRun = useCallback(async (runId: string) => {
    const run = await getScorecardRun(runId);
    if (run === null) return;
    activeRunId.current = runId;
    setStream(streamFromRun(run));
  }, []);

  const harden = useCallback(
    async (readingId: string): Promise<Task | null> => {
      if (stream.runId === null) return null;
      const task = await convertReadingToTask(stream.runId, readingId);
      setStream((prev) => ({
        ...prev,
        readings: prev.readings.map((r) =>
          r.id === readingId
            ? { ...r, status: 'converted', linkedTaskId: task.id }
            : r,
        ),
      }));
      await refreshRuns();
      return task;
    },
    [stream.runId, refreshRuns],
  );

  return { stream, runs, isStarting, startError, start, cancel, selectRun, harden };
}

/** Order rows for the results grid: graded rows worst-grade first, then ungraded
 *  (pending/running/errored) in dimension order. */
function sortRows(rows: DimensionRow[]): DimensionRow[] {
  return [...rows].sort((a, b) => {
    const ag = a.reading !== null ? 0 : 1;
    const bg = b.reading !== null ? 0 : 1;
    if (ag !== bg) return ag - bg;
    if (a.reading !== null && b.reading !== null) {
      return gradeRankValue(b.reading.grade) - gradeRankValue(a.reading.grade);
    }
    return 0;
  });
}

/** Everything the ScorecardView shell renders. `hasProject === false` is the only
 *  early-return branch; every other field is meaningful in the project view. */
export interface ScorecardViewModel {
  hasProject: boolean;
  projectName: string | null;
  stream: ScorecardStream;
  phase: RunPhase;
  config: ScorecardRunConfig;
  summary: string;
  isStarting: boolean;
  startError: string | null;
  runHistory: MenuItem[];
  hasHistory: boolean;
  /** RunProgress: the requested dimensions as ordered descriptors. */
  progressCategories: RunProgressCategory[];
  /** RunProgress: evidence count per dimension so far. */
  findingCounts: Record<string, number>;
  /** The grid rows (one per requested dimension), worst-grade first. */
  rows: DimensionRow[];
  emptyMessage: string;
  /** The reading open in the detail panel, or `null`. */
  selected: ScorecardReadingView | null;
  openReading: (reading: ScorecardReadingView) => void;
  closeReading: () => void;
  /** True while the harden action is in flight. */
  pending: boolean;
  onGrade: () => void;
  onCancel: () => void;
  startNewRun: () => void;
  onHarden: (readingId: string) => void;
  onGotoBoard?: () => void;
}

/** Resolve the entire Scorecard surface into a single view model. The component
 *  shell renders purely from this. */
export function useScorecardView({
  projectPath,
  projectName,
  onGotoBoard,
  preselect,
  onPreselectConsumed,
}: ScorecardViewProps): ScorecardViewModel {
  const hasProject = projectPath !== null;
  const scorecard = useScorecard(hasProject);
  const { stream } = scorecard;

  const config = useRunConfig(!hasProject);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reconfiguring, setReconfiguring] = useState(false);

  // Board→scan provenance navigation: a task's `sourceRef` chip landed here with
  // a run + reading to open. Consume the target FIRST (so it can never refire),
  // land on that run's RESULTS, and open the reading's detail panel. A deleted
  // run/reading degrades to the current stream with no panel — never an error.
  const { selectRun } = scorecard;
  useEffect(() => {
    if (preselect === null || preselect === undefined) return;
    const { runId, itemId } = preselect;
    onPreselectConsumed?.();
    setReconfiguring(false);
    void (async () => {
      await selectRun(runId);
      setSelectedId(itemId);
    })();
  }, [preselect, onPreselectConsumed, selectRun]);

  const phase: RunPhase =
    stream.status === 'running' || scorecard.isStarting
      ? 'running'
      : reconfiguring || stream.status === 'idle'
        ? 'configure'
        : 'results';

  const rows: DimensionRow[] = useMemo(() => {
    const byDim = new Map<string, ScorecardReadingView>();
    for (const r of stream.readings) byDim.set(r.dimension, r);
    const built: DimensionRow[] = stream.requestedDimensions.map((d) => ({
      dimension: d,
      state: stream.dimensionState[d] ?? 'pending',
      reading: byDim.get(d) ?? null,
    }));
    return sortRows(built);
  }, [stream.readings, stream.requestedDimensions, stream.dimensionState]);

  const selected = useMemo(
    () => stream.readings.find((r) => r.id === selectedId) ?? null,
    [stream.readings, selectedId],
  );

  const progressCategories: RunProgressCategory[] = useMemo(
    () =>
      stream.requestedDimensions.map((d) => ({
        key: d,
        label: DIMENSION_META[d].label,
        icon: DIMENSION_META[d].icon,
      })),
    [stream.requestedDimensions],
  );

  const findingCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of stream.readings) counts[r.dimension] = r.findings.length;
    return counts;
  }, [stream.readings]);

  const summary = useMemo(() => {
    const n = stream.requestedDimensions.length;
    const parts = [
      stream.model ?? 'default',
      ...(config.effort != null ? [config.effort] : []),
      `${n} ${n === 1 ? 'dimension' : 'dimensions'}`,
    ];
    return `⌖ ${parts.join(' · ')}`;
  }, [stream.model, stream.requestedDimensions, config.effort]);

  const runHistory: MenuItem[] = useMemo(
    () =>
      scorecard.runs.map((run) => ({
        label: `${new Date(run.createdAt).toLocaleString()} · ${run.readings.length} graded`,
        onClick: () => {
          setReconfiguring(false);
          void scorecard.selectRun(run.id);
        },
      })),
    [scorecard],
  );

  const emptyMessage = useMemo(() => {
    if (stream.status === 'idle') {
      return 'Grade the codebase to see per-dimension production-readiness scores.';
    }
    if (stream.status === 'running') return 'Grading…';
    if (stream.status === 'failed') {
      if (stream.failureReason === 'aborted') return 'Grading cancelled.';
      return `Grading failed${stream.error !== null ? `: ${stream.error}` : ''}.`;
    }
    return 'No dimensions graded.';
  }, [stream.status, stream.error, stream.failureReason]);

  const toast = useToast();
  const runAction = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setPending(true);
      try {
        await fn();
      } catch (err) {
        // Fired as `void runAction(...)`: surface a labeled toast instead of letting
        // the rejection fall through to the generic global handler (Insight parity).
        console.error(`${label} failed`, err);
        toast.error(`Could not ${label}`, err);
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
    isStarting: scorecard.isStarting,
    startError: scorecard.startError,
    runHistory,
    hasHistory: scorecard.runs.length > 0,
    progressCategories,
    findingCounts,
    rows,
    emptyMessage,
    selected,
    openReading: (reading: ScorecardReadingView) => setSelectedId(reading.id),
    closeReading: () => setSelectedId(null),
    pending,
    onGrade: () => {
      setReconfiguring(false);
      void scorecard.start(config.orderedSelected, config.model, config.effort);
    },
    onCancel: () => void scorecard.cancel(),
    startNewRun: () => {
      config.prefill({
        model: stream.model,
        categories: stream.requestedDimensions,
      });
      setReconfiguring(true);
    },
    onHarden: (id) => void runAction('harden dimension', () => scorecard.harden(id)),
    onGotoBoard,
  };
}
