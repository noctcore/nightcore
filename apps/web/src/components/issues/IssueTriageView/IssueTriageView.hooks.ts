/** Hooks that resolve the Issue Triage surface into a single view model: the issue
 *  list + selection + detail fetch, the model/effort config, the shared validation
 *  run-lifecycle (via `useScanRun`), and the two human-gated action dialogs. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useToast } from '@/components/ui';
import {
  fetchProjectIssueDetail,
  getIssueValidation,
  type IssueDetail,
  type IssueSummary,
  listProjectIssues,
} from '@/lib/bridge';
import { usePreselectNavigation } from '@/lib/usePreselectNavigation';

import { EMPTY_ISSUE_TRIAGE_STREAM, type IssueTriageStream } from '../issue-stream';
import {
  COMPLEXITY_META,
  COMPLEXITY_TO_EFFORT,
  suggestedTaskKind,
} from '../issue-triage.constants';
import type { IssueValidationBadge } from '../IssueList/IssueList.types';
import {
  type ConvertDialogState,
  type PostDialogState,
  useIssueActionDialogs,
} from './hooks/useIssueActionDialogs.hooks';
import { useIssueTriage } from './hooks/useIssueTriage.hooks';
import type { IssueTriageViewProps } from './IssueTriageView.types';
import { errMessage, matchesFilter } from './IssueTriageView.utils';

/** Everything the IssueTriageView shell renders. `hasProject === false` is the only
 *  early-return branch; every other field is meaningful in the project view. */
export interface IssueTriageViewModel {
  hasProject: boolean;
  projectName: string | null;
  // Issue list
  issues: IssueSummary[];
  totalCount: number;
  issuesLoading: boolean;
  issuesError: string | null;
  filter: string;
  onFilterChange: (value: string) => void;
  selectedNumber: number | null;
  onSelectIssue: (issue: IssueSummary) => void;
  onRefreshIssues: () => void;
  badgeByNumber: Record<number, IssueValidationBadge>;
  // Detail
  selectedIssue: IssueSummary | null;
  detail: IssueDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  // Validation lifecycle for the selected issue
  panelStream: IssueTriageStream;
  model: string | null;
  effort: string | null;
  onChangeModel: (model: string | null) => void;
  onChangeEffort: (effort: string | null) => void;
  canValidate: boolean;
  running: boolean;
  hasVerdict: boolean;
  stale: boolean;
  startError: string | null;
  onValidate: () => void;
  onCancel: () => void;
  // Failure notice
  failed: boolean;
  failedIsCancel: boolean;
  failureMessage: string | null;
  // Actions
  onGotoBoard?: () => void;
  // Post dialog
  postDialog: PostDialogState;
  onOpenPostDialog: () => void;
  onClosePostDialog: () => void;
  onSubmitPost: () => void;
  // Convert dialog
  convertDialog: ConvertDialogState;
  suggestedKind: 'Build' | 'Decompose';
  complexityLabel: string | null;
  effortLabel: string | null;
  alreadyLinked: boolean;
  onOpenConvertDialog: () => void;
  onCloseConvertDialog: () => void;
  onSubmitConvert: () => void;
}

/** Resolve the entire Issue Triage surface into a single view model. */
export function useIssueTriageView({
  projectPath,
  projectName,
  onGotoBoard,
  preselect,
  onPreselectConsumed,
}: IssueTriageViewProps): IssueTriageViewModel {
  const hasProject = projectPath !== null;
  const toast = useToast();
  const triage = useIssueTriage(hasProject);
  const { selectRun, reset, convert } = triage;

  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const [selectedIssue, setSelectedIssue] = useState<IssueSummary | null>(null);
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);

  // Latest runs, read through a ref so `selectIssue` picks the right validation
  // without re-creating on every run-list change.
  const runsRef = useRef(triage.runs);
  runsRef.current = triage.runs;

  const loadIssues = useCallback(async () => {
    if (projectPath === null) {
      setIssues([]);
      return;
    }
    setIssuesLoading(true);
    setIssuesError(null);
    try {
      setIssues(await listProjectIssues());
    } catch (err) {
      setIssuesError(errMessage(err));
      setIssues([]);
    } finally {
      setIssuesLoading(false);
    }
  }, [projectPath]);

  // Load the issue list on mount / project change.
  useEffect(() => {
    void loadIssues();
  }, [loadIssues]);

  // Fetch one issue's detail (body + comments); shared by list-select + preselect.
  const loadDetail = useCallback(async (issueNumber: number) => {
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      setDetail(await fetchProjectIssueDetail(issueNumber));
    } catch (err) {
      setDetailError(errMessage(err));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const onSelectIssue = useCallback(
    (issue: IssueSummary) => {
      setSelectedIssue(issue);
      // Load the newest existing validation for this issue (runs are newest-first),
      // else reset the stream so the panel shows the validate controls.
      const existing = runsRef.current.find((r) => r.issueNumber === issue.number);
      if (existing !== undefined) void selectRun(existing.id);
      else reset();
      void loadDetail(issue.number);
    },
    [selectRun, reset, loadDetail],
  );

  // Board→triage provenance: a task's `sourceRef` (`issue-triage:<runId>`) navigated
  // here. Load that validation run + synthesize its issue header from the run so the
  // panel opens on the cached verdict even if the issue has since closed.
  const preselectRun = useCallback(
    async (runId: string) => {
      const run = await getIssueValidation(runId);
      await selectRun(runId);
      if (run === null) return;
      setSelectedIssue({
        number: run.issueNumber,
        title: run.issueTitle,
        state: 'open',
        labels: [],
        author: '',
        createdAt: '',
        updatedAt: '',
        commentCount: 0,
        linkedPrs: [],
      });
      void loadDetail(run.issueNumber);
    },
    [selectRun, loadDetail],
  );

  usePreselectNavigation({
    preselect,
    onPreselectConsumed,
    selectRun: preselectRun,
    onEnter: () => setFilter(''),
    onOpenItem: () => {},
  });

  // The stream folds only for the selected issue; guard on the issue number so a
  // stale stream from a just-deselected issue never leaks into the panel.
  const selectedNumber = selectedIssue?.number ?? null;
  const streamMatches =
    selectedNumber !== null && triage.stream.issueNumber === selectedNumber;
  const panelStream = streamMatches ? triage.stream : EMPTY_ISSUE_TRIAGE_STREAM;
  const running = triage.isStarting || (streamMatches && panelStream.status === 'running');
  const hasVerdict = streamMatches && panelStream.result !== null;
  const failed = streamMatches && panelStream.status === 'failed';
  const canValidate = hasProject && detail !== null && !running;

  const stale = useMemo(() => {
    if (!hasVerdict || selectedIssue === null || panelStream.validatedAt === null) return false;
    // Both sides are epoch ms: GitHub's ISO `updatedAt` parsed vs the run's
    // `updated_at` (Rust stores epoch ms). Stale when the issue moved since validation.
    const updated = Date.parse(selectedIssue.updatedAt);
    return !Number.isNaN(updated) && updated > panelStream.validatedAt;
  }, [hasVerdict, selectedIssue, panelStream.validatedAt]);

  const filteredIssues = useMemo(
    () => issues.filter((issue) => matchesFilter(issue, filter)),
    [issues, filter],
  );

  const badgeByNumber = useMemo(() => {
    const map: Record<number, IssueValidationBadge> = {};
    const issueByNumber = new Map(issues.map((i) => [i.number, i]));
    const seen = new Set<number>();
    for (const run of triage.runs) {
      // Runs are newest-first; the first per issue is the current one.
      if (seen.has(run.issueNumber)) continue;
      seen.add(run.issueNumber);
      if (run.status !== 'completed') continue;
      const issue = issueByNumber.get(run.issueNumber);
      // Epoch-ms comparison (see `stale` above): GitHub ISO `updatedAt` vs the run's
      // epoch-ms `updated_at`.
      const isStale = issue !== undefined && Date.parse(issue.updatedAt) > run.updatedAt;
      map[run.issueNumber] = isStale ? 'stale' : 'validated';
    }
    return map;
  }, [triage.runs, issues]);

  // --- Actions -------------------------------------------------------------

  const onValidate = useCallback(() => {
    if (selectedIssue === null || detail === null) return;
    void triage.start(selectedIssue, detail, model, effort);
  }, [selectedIssue, detail, triage, model, effort]);

  const dialogs = useIssueActionDialogs({
    runId: panelStream.runId,
    hasResult: panelStream.result !== null,
    selectRun,
    convert,
    toast,
  });

  const complexity = panelStream.result?.estimatedComplexity ?? null;

  return {
    hasProject,
    projectName,
    issues: filteredIssues,
    totalCount: issues.length,
    issuesLoading,
    issuesError,
    filter,
    onFilterChange: setFilter,
    selectedNumber,
    onSelectIssue,
    onRefreshIssues: () => void loadIssues(),
    badgeByNumber,
    selectedIssue,
    detail,
    detailLoading,
    detailError,
    panelStream,
    model,
    effort,
    onChangeModel: setModel,
    onChangeEffort: setEffort,
    canValidate,
    running,
    hasVerdict,
    stale,
    startError: triage.startError,
    onValidate,
    onCancel: () => void triage.cancel(),
    failed,
    failedIsCancel: failed && panelStream.failureReason === 'aborted',
    failureMessage: panelStream.error,
    onGotoBoard,
    postDialog: dialogs.postDialog,
    onOpenPostDialog: dialogs.onOpenPostDialog,
    onClosePostDialog: dialogs.onClosePostDialog,
    onSubmitPost: dialogs.onSubmitPost,
    convertDialog: dialogs.convertDialog,
    suggestedKind:
      panelStream.result !== null
        ? suggestedTaskKind(panelStream.result.issueKind, complexity)
        : 'Build',
    complexityLabel: complexity !== null ? COMPLEXITY_META[complexity].label : null,
    effortLabel: complexity !== null ? COMPLEXITY_TO_EFFORT[complexity] : null,
    alreadyLinked: panelStream.linkedTaskId !== null,
    onOpenConvertDialog: dialogs.onOpenConvertDialog,
    onCloseConvertDialog: dialogs.onCloseConvertDialog,
    onSubmitConvert: dialogs.onSubmitConvert,
  };
}
