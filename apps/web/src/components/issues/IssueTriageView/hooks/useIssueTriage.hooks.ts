/** The validation run-lifecycle for the single active/selected issue: the live
 *  `issue-validation-*` fold, authoritative reconciliation on completion, single-flight
 *  start, cancel, and the convert-to-task side effect. Built on the shared `useScanRun`. */
import { type MutableRefObject, useCallback } from 'react';

import {
  cancelIssueValidation,
  convertIssueValidationToTask,
  type EffortLevel,
  getIssueValidation,
  type IssueDetail,
  type IssueSummary,
  type IssueTriageEvent,
  type IssueValidationRun,
  listIssueValidations,
  onIssueTriageEvent,
  startIssueValidation,
  type Task,
} from '@/lib/bridge';
import { useScanRun } from '@/lib/useScanRun';

import {
  EMPTY_ISSUE_TRIAGE_STREAM,
  foldIssueTriage,
  type IssueTriageStream,
  streamFromRun,
} from '../../issue-stream';

/** The validation run-lifecycle for the single active/selected issue. */
export interface UseIssueTriageResult {
  stream: IssueTriageStream;
  runs: IssueValidationRun[];
  isStarting: boolean;
  startError: string | null;
  activeRunId: MutableRefObject<string | null>;
  start: (
    issue: IssueSummary,
    detail: IssueDetail,
    model: string | null,
    effort: string | null,
  ) => Promise<void>;
  cancel: () => Promise<void>;
  selectRun: (runId: string) => Promise<void>;
  reset: () => void;
  refreshRuns: () => Promise<IssueValidationRun[]>;
  convert: (runId: string) => Promise<Task>;
}

/** Drive the validation lifecycle: live `issue-validation-*` fold for the active run,
 *  authoritative reconciliation on completion, single-flight start, cancel, and the
 *  convert side effect. Mirrors `useInsight`. */
export function useIssueTriage(hasProject: boolean): UseIssueTriageResult {
  const scan = useScanRun<IssueTriageEvent, IssueValidationRun, IssueTriageStream>({
    emptyStream: EMPTY_ISSUE_TRIAGE_STREAM,
    listRuns: listIssueValidations,
    getRun: getIssueValidation,
    streamFromRun,
    cancelRun: cancelIssueValidation,
    subscribe: onIssueTriageEvent,
    onEvent: (event, { activeRunId, setStream, refreshRuns, reconcile }) => {
      if (event.type === 'issue-validation-converted') {
        setStream((prev) =>
          prev.runId === event.runId ? { ...prev, linkedTaskId: event.taskId } : prev,
        );
        void refreshRuns();
        return;
      }
      // Lifecycle events only apply to the run currently displayed/driven.
      if (event.runId !== activeRunId.current) return;
      setStream((prev) => foldIssueTriage(prev, event));
      if (event.type === 'issue-validation-completed' || event.type === 'issue-validation-failed') {
        void reconcile(event.runId);
      }
    },
  });
  const { setStream, runStart, refreshRuns, activeRunId } = scan;

  const start = useCallback(
    async (
      issue: IssueSummary,
      detail: IssueDetail,
      model: string | null,
      effort: string | null,
    ) => {
      await runStart(hasProject, async () => {
        const runId = await startIssueValidation(
          {
            issueNumber: issue.number,
            issueTitle: issue.title,
            issueBody: detail.body,
            issueAuthor: issue.author,
            labels: issue.labels,
            comments: detail.comments,
            linkedPrs: issue.linkedPrs,
          },
          { model, effort: effort as EffortLevel | null },
        );
        // Optimistic running state until `issue-validation-started` lands.
        return {
          runId,
          optimistic: {
            ...EMPTY_ISSUE_TRIAGE_STREAM,
            runId,
            issueNumber: issue.number,
            status: 'running',
            model,
          },
        };
      });
    },
    [hasProject, runStart],
  );

  const reset = useCallback(() => {
    activeRunId.current = null;
    setStream(EMPTY_ISSUE_TRIAGE_STREAM);
  }, [activeRunId, setStream]);

  const convert = useCallback(
    async (runId: string): Promise<Task> => {
      const task = await convertIssueValidationToTask(runId);
      setStream((prev) => (prev.runId === runId ? { ...prev, linkedTaskId: task.id } : prev));
      await refreshRuns();
      return task;
    },
    [setStream, refreshRuns],
  );

  return {
    stream: scan.stream,
    runs: scan.runs,
    isStarting: scan.isStarting,
    startError: scan.startError,
    activeRunId,
    start,
    cancel: scan.cancel,
    selectRun: scan.selectRun,
    reset,
    refreshRuns,
    convert,
  };
}
