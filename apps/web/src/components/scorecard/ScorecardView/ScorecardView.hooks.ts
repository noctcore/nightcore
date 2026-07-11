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
import { formatRunReceipt } from '@/lib/formatters';
import {
  countOpenItems,
  deriveRunPhase,
  patchStreamItem,
  seedStepState,
} from '@/lib/scan-run';
import { useBulkConvert } from '@/lib/useBulkConvert';
import { usePreselectNavigation } from '@/lib/usePreselectNavigation';
import { useScanItemActions } from '@/lib/useScanItemActions';
import { useScanResultsView } from '@/lib/useScanResultsView';
import { useScanRun } from '@/lib/useScanRun';

import type { DimensionRow } from '../DimensionGrid';
import { useRunConfig } from '../RunControls/RunControls.hooks';
import type { ScorecardRunConfig } from '../RunControls/RunControls.types';
import { DIMENSION_META } from '../scorecard.constants';
import type { ScorecardReadingView } from '../scorecard.types';
import { buildDimensionRows } from '../scorecard-rows';
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
  /** Bulk harden: every open (not-yet-hardened) reading → tasks (idempotent). */
  convertAll: () => void;
  bulkConverting: boolean;
  bulkProgress: { done: number; total: number; failed: number };
  /** Polite aria-live announcement for the convert-all flow ('' when idle). */
  bulkStatusMessage: string;
  /** Inline failure summary when conversions rejected mid-loop, else `null`. */
  bulkError: string | null;
  /** Count of open (hardenable) readings in the current run. */
  openCount: number;
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

  // Bulk convert-all (the shared Insight idiom): "harden every open reading →
  // tasks" over the per-reading `harden` seam. The convert closure is read
  // through a ref inside, so its rebinding on `stream.runId` is safe.
  const { resetBulk, convertAll, bulkConverting, bulkProgress, bulkStatusMessage, bulkError } =
    useBulkConvert(scorecard.harden, 'convertReadingToTask failed');

  // Reset the results transient state AND the convert-all counters together, so a
  // prior run's "Converted k/N" summary can't bleed into a freshly entered run.
  const resetRun = useCallback(() => {
    resetTransient();
    resetBulk();
  }, [resetTransient, resetBulk]);

  // Board→scan provenance navigation: a task's `sourceRef` chip landed here with
  // a run + reading to open. Consume the target FIRST, land on that run's RESULTS,
  // and open the reading's detail panel.
  usePreselectNavigation({
    preselect,
    onPreselectConsumed,
    selectRun: scorecard.selectRun,
    onEnter: resetRun,
    onOpenItem: (target) => setSelectedId(target.itemId),
  });

  const phase: RunPhase = deriveRunPhase(stream.status, scorecard.isStarting, view.reconfiguring);

  // Grade-trend rows (T8): built from the displayed stream + the persisted run list
  // so each dimension carries its grade trend vs the most recent OLDER run.
  const rows: DimensionRow[] = useMemo(
    () => buildDimensionRows(stream, scorecard.runs),
    [stream, scorecard.runs],
  );

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
        label: `${new Date(run.createdAt).toLocaleString()} · ${run.readings.length} graded · ${formatRunReceipt(run.costUsd, run.durationMs)}`,
        onClick: () => {
          resetRun();
          void scorecard.selectRun(run.id);
        },
      })),
    [scorecard, resetRun],
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
      resetRun();
      void scorecard.start(config.orderedSelected, config.model, config.effort, config.providerId);
    },
    onCancel: () => void scorecard.cancel(),
    convertAll: () =>
      convertAll(stream.readings.filter((r) => r.status === 'open')),
    bulkConverting,
    bulkProgress,
    bulkStatusMessage,
    bulkError,
    openCount: countOpenItems(stream.readings),
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
