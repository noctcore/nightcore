/** The Insight run stream and finding actions: the live `analysis-*` fold for the
 *  active run, authoritative reconciliation against the persisted run, and the
 *  dismiss/restore/convert triple over the findings list. */
import { useCallback } from 'react';

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
import { patchStreamItem, seedStepState } from '@/lib/scan-run';
import { useScanItemActions } from '@/lib/useScanItemActions';
import { useScanRun } from '@/lib/useScanRun';

import { DEFAULT_DEEP_SCAN_CONFIG } from '../../insight.constants';
import type { InsightFinding } from '../../insight.types';
import {
  EMPTY_INSIGHT_STREAM,
  foldInsight,
  type InsightStream,
  streamFromRun,
} from '../../insight-stream';

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
    providerId: string | null,
    /** Opt-in DEEP scan mode (issue #294). `true` sends the explicit
     *  {@link DEFAULT_DEEP_SCAN_CONFIG} (never an empty object — see that
     *  constant's doc for why). */
    deep: boolean,
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
          patchStreamItem(prev, {
            runId: event.runId,
            itemId: event.findingId,
            items: (s) => s.findings,
            write: (s, findings) => ({ ...s, findings }),
            patch: (f) => ({ ...f, status: 'converted' as const, linkedTaskId: event.taskId }),
          }),
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
      providerId: string | null,
      deep: boolean,
    ) => {
      await runStart(hasProject && categories.length > 0, async () => {
        const runId = await startAnalysis(scope, categories, {
          model,
          effort: effort as EffortLevel | null,
          providerId,
          // Explicit values only — see `DEFAULT_DEEP_SCAN_CONFIG`'s doc: the
          // generated Rust struct zero-defaults any field an empty `{}` omits.
          deep: deep ? DEFAULT_DEEP_SCAN_CONFIG : null,
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

  // The shared dismiss/restore/convert triple over the findings list.
  const { dismiss, restore, convert } = useScanItemActions<
    InsightRun,
    InsightStream,
    InsightFinding
  >({
    runId: stream.runId,
    setStream,
    refreshRuns,
    streamFromRun,
    items: (s) => s.findings,
    writeItems: (s, findings) => ({ ...s, findings }),
    dismissItem: dismissFinding,
    restoreItem: restoreFinding,
    convert: {
      run: convertFindingToTask,
      mark: (f, taskId) => ({ ...f, status: 'converted' as const, linkedTaskId: taskId }),
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
    dismiss,
    restore,
    convert,
  };
}
