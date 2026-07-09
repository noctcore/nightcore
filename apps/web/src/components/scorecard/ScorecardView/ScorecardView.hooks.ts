import { useCallback, useMemo } from 'react';

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
import { deriveRunPhase, patchStreamItem, seedStepState } from '@/lib/scan-run';
import { usePreselectNavigation } from '@/lib/usePreselectNavigation';
import { useScanItemActions } from '@/lib/useScanItemActions';
import { useScanResultsView } from '@/lib/useScanResultsView';
import { useScanRun } from '@/lib/useScanRun';

import type { DimensionRow } from '../DimensionGrid';
import { useRunConfig } from '../RunControls/RunControls.hooks';
import type { ScorecardRunConfig } from '../RunControls/RunControls.types';
import { DIMENSION_META, gradeRankValue } from '../scorecard.constants';
import type { ScorecardReadingView } from '../scorecard.types';
import {
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
    providerId: string | null,
  ) => Promise<void>;
  cancel: () => Promise<void>;
  selectRun: (runId: string) => Promise<void>;
  harden: (readingId: string) => Promise<Task | null>;
}

/** Drive the Scorecard data layer: live `scorecard-*` fold for the active run,
 *  authoritative reconciliation against the persisted run on completion, and the
 *  harden action. The Profile twin of `useInsight`, minus dismiss/restore. */
function useScorecard(hasProject: boolean): UseScorecardResult {
  const scan = useScanRun<ScorecardEvent, ScorecardRun, ScorecardStream>({
    emptyStream: EMPTY_SCORECARD_STREAM,
    listRuns: listScorecardRuns,
    getRun: getScorecardRun,
    streamFromRun,
    cancelRun: cancelScorecard,
    subscribe: onScorecardEvent,
    onEvent: (event, { activeRunId, setStream, refreshRuns, reconcile }) => {
      if (event.type === 'reading-converted') {
        setStream((prev) =>
          patchStreamItem(prev, {
            runId: event.runId,
            itemId: event.readingId,
            items: (s) => s.readings,
            write: (s, readings) => ({ ...s, readings }),
            patch: (r) => ({
              ...r,
              status: 'converted' as const,
              linkedTaskId: event.taskId,
            }),
          }),
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
    },
  });
  const { stream, setStream, runStart, refreshRuns } = scan;

  const start = useCallback(
    async (
      dimensions: ScorecardDimension[],
      model: string | null,
      effort: string | null,
      providerId: string | null,
    ) => {
      await runStart(hasProject && dimensions.length > 0, async () => {
        const runId = await startScorecard(dimensions, {
          model,
          effort: effort as EffortLevel | null,
          providerId,
        });
        return {
          runId,
          optimistic: {
            ...EMPTY_SCORECARD_STREAM,
            runId,
            status: 'running',
            model,
            requestedDimensions: dimensions,
            dimensionState: seedStepState(dimensions),
          },
        };
      });
    },
    [hasProject, runStart],
  );

  // The shared item-action triple over the readings list; Scorecard only wires
  // `convert` (its "harden" action) — readings have no dismiss/restore lifecycle.
  const { convert: harden } = useScanItemActions<
    ScorecardRun,
    ScorecardStream,
    ScorecardReadingView
  >({
    runId: stream.runId,
    setStream,
    refreshRuns,
    streamFromRun,
    items: (s) => s.readings,
    writeItems: (s, readings) => ({ ...s, readings }),
    convert: {
      run: convertReadingToTask,
      mark: (r, taskId) => ({ ...r, status: 'converted' as const, linkedTaskId: taskId }),
    },
  });

  return {
    stream,
    runs: scan.runs,
    isStarting: scan.isStarting,
    startError: scan.startError,
    start,
    cancel: scan.cancel,
    selectRun: scan.selectRun,
    harden,
  };
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

  const toast = useToast();
  // The shared results-view cluster; Scorecard uses only selection / pending /
  // reconfigure (its grid has no tabs and its RUNNING screen has no peek).
  const view = useScanResultsView<ScorecardDimension>({
    notifyError: (title, err) => toast.error(title, err),
  });
  const { setSelectedId, resetTransient, runAction } = view;

  // Board→scan provenance navigation: a task's `sourceRef` chip landed here with
  // a run + reading to open. Consume the target FIRST, land on that run's RESULTS,
  // and open the reading's detail panel.
  usePreselectNavigation({
    preselect,
    onPreselectConsumed,
    selectRun: scorecard.selectRun,
    onEnter: resetTransient,
    onOpenItem: (target) => setSelectedId(target.itemId),
  });

  const phase: RunPhase = deriveRunPhase(stream.status, scorecard.isStarting, view.reconfiguring);

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
    () => stream.readings.find((r) => r.id === view.selectedId) ?? null,
    [stream.readings, view.selectedId],
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
          resetTransient();
          void scorecard.selectRun(run.id);
        },
      })),
    [scorecard, resetTransient],
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
    pending: view.pending,
    onGrade: () => {
      resetTransient();
      void scorecard.start(config.orderedSelected, config.model, config.effort, config.providerId);
    },
    onCancel: () => void scorecard.cancel(),
    startNewRun: () => {
      config.prefill({
        model: stream.model,
        categories: stream.requestedDimensions,
      });
      view.startReconfigure();
    },
    onHarden: (id) => void runAction('harden dimension', () => scorecard.harden(id)),
    onGotoBoard,
  };
}
