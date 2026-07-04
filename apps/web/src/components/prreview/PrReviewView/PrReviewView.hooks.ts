/** Hooks that resolve the PR Review surface into a single view model: the live and
 *  persisted run stream, the lifted run-config, the finding selection, and the
 *  human-gated post-review state machine. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  MenuItem,
  RunPhase,
  RunProgressCategory,
} from '@/components/ui';
import { useToast } from '@/components/ui';
import {
  cancelPrReview,
  convertReviewFindingToTask,
  dismissReviewFinding,
  type EffortLevel,
  getPrReviewRun,
  listPrReviewRuns,
  onPrReviewEvent,
  postReviewToGithub,
  type PrReviewEvent,
  type PrReviewRun,
  restoreReviewFinding,
  type ReviewInlineComment,
  type ReviewLens,
  startPrReview,
  type Task,
} from '@/lib/bridge';
import { seedStepState } from '@/lib/scan-run';
import { useScanRun } from '@/lib/useScanRun';

import {
  LENS_META,
  SEVERITY_META,
  SEVERITY_ORDER,
  severityRankValue,
} from '../prreview.constants';
import type { ReviewFindingView, ReviewVerdict } from '../prreview.types';
import {
  EMPTY_REVIEW_STREAM,
  foldReview,
  type LensProgress,
  type ReviewStream,
  streamFromRun,
} from '../prreview-stream';
import type { PrReviewRunConfig } from '../RunControls';
import { useRunConfig } from '../RunControls';
import type { PrReviewViewProps } from './PrReviewView.types';

export interface UsePrReviewResult {
  stream: ReviewStream;
  runs: PrReviewRun[];
  isStarting: boolean;
  startError: string | null;
  /** Resolves `true` once the run has actually started (the synchronous
   *  `gh pr diff` fetch succeeded and the running state is armed); `false` if the
   *  start was rejected (startError is set) or guarded out. Callers use this to
   *  decide whether to leave the configure screen. */
  start: (
    prNumber: number,
    lenses: ReviewLens[],
    model: string | null,
    effort: string | null,
  ) => Promise<boolean>;
  cancel: () => Promise<void>;
  selectRun: (runId: string) => Promise<void>;
  dismiss: (findingId: string) => Promise<void>;
  restore: (findingId: string) => Promise<void>;
  convert: (findingId: string) => Promise<Task | null>;
}

/** Drive the PR Review view: live `pr-review-*` fold for the active run,
 *  authoritative reconciliation against the persisted run on completion, and
 *  finding actions. Clone of `useInsight`. */
export function usePrReview(hasProject: boolean): UsePrReviewResult {
  const scan = useScanRun<PrReviewEvent, PrReviewRun, ReviewStream>({
    emptyStream: EMPTY_REVIEW_STREAM,
    listRuns: listPrReviewRuns,
    getRun: getPrReviewRun,
    streamFromRun,
    cancelRun: cancelPrReview,
    subscribe: onPrReviewEvent,
    onEvent: (event, { activeRunId, setStream, refreshRuns, reconcile }) => {
      if (event.type === 'pr-review-finding-converted') {
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
      // pr-review-* lens events only apply to the run currently displayed/driven.
      if (event.runId !== activeRunId.current) return;
      setStream((prev) => foldReview(prev, event));
      if (event.type === 'pr-review-completed' || event.type === 'pr-review-failed') {
        void reconcile(event.runId);
      }
    },
  });
  const { stream, setStream, runStart, refreshRuns } = scan;

  const start = useCallback(
    (
      prNumber: number,
      lenses: ReviewLens[],
      model: string | null,
      effort: string | null,
    ) =>
      runStart(hasProject && lenses.length > 0 && prNumber > 0, async () => {
        const runId = await startPrReview(prNumber, lenses, {
          model,
          effort: effort as EffortLevel | null,
        });
        // Optimistic running state until `pr-review-started` lands. Carries the PR
        // number (the started event omits it) so the post-review target survives.
        return {
          runId,
          optimistic: {
            ...EMPTY_REVIEW_STREAM,
            runId,
            status: 'running',
            prNumber,
            model,
            requestedLenses: lenses,
            lensState: seedStepState(lenses),
          },
        };
      }),
    [hasProject, runStart],
  );

  const dismiss = useCallback(
    async (findingId: string) => {
      if (stream.runId === null) return;
      const run = await dismissReviewFinding(stream.runId, findingId);
      if (run !== null) setStream(streamFromRun(run));
      await refreshRuns();
    },
    [stream.runId, setStream, refreshRuns],
  );

  const restore = useCallback(
    async (findingId: string) => {
      if (stream.runId === null) return;
      const run = await restoreReviewFinding(stream.runId, findingId);
      if (run !== null) setStream(streamFromRun(run));
      await refreshRuns();
    },
    [stream.runId, setStream, refreshRuns],
  );

  const convert = useCallback(
    async (findingId: string): Promise<Task | null> => {
      if (stream.runId === null) return null;
      const task = await convertReviewFindingToTask(stream.runId, findingId);
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

const RUNNING: LensProgress = 'running';

/** Order findings for display: open before resolved, then severity (high→low). */
function sortFindings(findings: ReviewFindingView[]): ReviewFindingView[] {
  const statusRank = (f: ReviewFindingView) => (f.status === 'open' ? 0 : 1);
  return [...findings].sort((a, b) => {
    const s = statusRank(a) - statusRank(b);
    if (s !== 0) return s;
    return severityRankValue(b.severity) - severityRankValue(a.severity);
  });
}

function openCount(findings: ReviewFindingView[]): number {
  return findings.filter((f) => f.status === 'open').length;
}

/** The one-line verdict framing prepended to the composed review body. */
const VERDICT_SUMMARY: Record<ReviewVerdict, string> = {
  approve: 'Approving — the changes look good. Notes below.',
  'request-changes':
    'Requesting changes — please address the findings below before merge.',
  comment: 'Review notes below.',
};

/** Compose the review body markdown from the SELECTED findings, grouped by
 *  severity. Nightcore's own trusted text — never raw foreign diff. */
export function composeReviewBody(
  verdict: ReviewVerdict,
  findings: ReviewFindingView[],
): string {
  const lines: string[] = ['## Nightcore PR Review', '', VERDICT_SUMMARY[verdict]];
  for (const severity of SEVERITY_ORDER) {
    const items = findings.filter((f) => f.severity === severity);
    if (items.length === 0) continue;
    lines.push('', `### ${SEVERITY_META[severity].label}`);
    for (const f of items) {
      const loc = f.line !== null ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      lines.push(`- ${loc} — **${f.title}** _(${LENS_META[f.lens].label})_`);
    }
  }
  lines.push('', '_Posted from Nightcore._');
  return lines.join('\n');
}

/** Inline comments for the SELECTED findings that carry a line anchor. The body is
 *  Nightcore-composed (title + finding body) — trusted text, never the raw diff. */
export function composeReviewComments(
  findings: ReviewFindingView[],
): ReviewInlineComment[] {
  return findings
    .filter((f) => f.line !== null)
    .map((f) => ({
      path: f.file,
      line: f.line as number,
      body: `${f.title}\n\n${f.body}`,
    }));
}

/** Everything the PrReviewView shell renders. `hasProject === false` is the only
 *  early-return branch; every other field is meaningful in the project view. */
export interface PrReviewViewModel {
  hasProject: boolean;
  projectName: string | null;
  stream: ReviewStream;
  /** Which lifecycle screen (CONFIGURE / RUNNING / RESULTS) is active. */
  phase: RunPhase;
  /** The lifted run-config form state, passed straight into RunControls. */
  config: PrReviewRunConfig;
  /** The collapsed-config summary string for the shell's summary bar. */
  summary: string;
  isStarting: boolean;
  startError: string | null;
  /** Run-history menu entries (newest first), each selecting that run. */
  runHistory: MenuItem[];
  hasHistory: boolean;
  /** RunProgress: the requested lenses as ordered descriptors. */
  progressCategories: RunProgressCategory[];
  /** RunProgress: total findings produced per lens so far. */
  findingCounts: Record<string, number>;
  /** The findings for the RESULTS grid (sorted; grouped by severity downstream). */
  gridFindings: ReviewFindingView[];
  skeletonCount: number;
  emptyMessage: string;
  /** The finding open in the detail panel, or `null`. */
  selected: ReviewFindingView | null;
  openFinding: (finding: ReviewFindingView) => void;
  closeFinding: () => void;
  /** True while a finding action (convert/dismiss/restore) is in flight. */
  pending: boolean;
  onReview: () => void;
  onCancel: () => void;
  /** "New run" / "Retry": back to CONFIGURE, pre-filled from the last run. */
  startNewRun: () => void;
  /** Bulk convert: open, not-yet-converted findings → tasks (idempotent). */
  convertAll: () => void;
  bulkConverting: boolean;
  bulkProgress: { done: number; total: number; failed: number };
  bulkStatusMessage: string;
  bulkError: string | null;
  openCount: number;
  onConvert: (findingId: string) => void;
  onDismiss: (findingId: string) => void;
  onRestore: (findingId: string) => void;
  onGotoBoard?: () => void;
  // --- Selection + post-review gate ---
  /** The set of finding ids selected for the posted review. */
  selection: ReadonlySet<string>;
  onToggleSelect: (findingId: string) => void;
  selectedCount: number;
  /** How many selected findings carry a line anchor (become inline comments). */
  selectedInlineCount: number;
  /** Whether the post-review toolbar is actionable (completed run + ≥1 selected). */
  canPost: boolean;
  /** The verdict whose ConfirmDialog is open, or `null`. */
  postVerdict: ReviewVerdict | null;
  posting: boolean;
  postError: string | null;
  /** Open the ConfirmDialog for a verdict (human gate — never auto-fires). */
  requestPost: (verdict: ReviewVerdict) => void;
  /** Confirm + await the post (composes body + comments from the selection). */
  confirmPost: () => void;
  /** Cancel the gate. A no-op while a post is in flight. */
  cancelPost: () => void;
}

/** Resolve the entire PR Review surface into a single view model. Clone of
 *  `useInsightView`, plus the finding selection and the human-gated post-review
 *  state machine. The component shell renders purely from this. */
export function usePrReviewView({
  projectPath,
  projectName,
  onGotoBoard,
  preselect,
  onPreselectConsumed,
}: PrReviewViewProps): PrReviewViewModel {
  const hasProject = projectPath !== null;
  const toast = useToast();
  const prReview = usePrReview(hasProject);
  const { stream } = prReview;

  // Lifted run-config form state — lives above RunControls so it survives the
  // CONFIGURE → RUNNING → RESULTS phase swaps and pre-fills on "New run".
  const config = useRunConfig(!hasProject);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reconfiguring, setReconfiguring] = useState(false);
  // The findings checked for inclusion in the posted review.
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  // Bulk convert-all progress.
  const [bulkConverting, setBulkConverting] = useState(false);
  const [bulkTotal, setBulkTotal] = useState(0);
  const [bulkDone, setBulkDone] = useState(0);
  const [bulkFailed, setBulkFailed] = useState(0);
  const convertAllInFlight = useRef(false);
  // Post-review human gate: the pending verdict (dialog open when non-null), the
  // in-flight flag (blocks double-fire + cancel), and the last error.
  const [postVerdict, setPostVerdict] = useState<ReviewVerdict | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const postInFlight = useRef(false);

  const resetBulk = useCallback(() => {
    setBulkTotal(0);
    setBulkDone(0);
    setBulkFailed(0);
  }, []);

  // Board→scan provenance navigation: a task's `sourceRef` chip landed here with a
  // run + finding to open. Consume the target FIRST (so it can never refire), land
  // on that run's RESULTS, and open the finding's detail panel.
  const { selectRun } = prReview;
  useEffect(() => {
    if (preselect === null || preselect === undefined) return;
    const { runId, itemId } = preselect;
    onPreselectConsumed?.();
    setReconfiguring(false);
    resetBulk();
    setSelection(new Set());
    void (async () => {
      await selectRun(runId);
      setSelectedId(itemId);
    })();
  }, [preselect, onPreselectConsumed, selectRun, resetBulk]);

  const phase: RunPhase =
    stream.status === 'running' || prReview.isStarting
      ? 'running'
      : reconfiguring || stream.status === 'idle'
        ? 'configure'
        : 'results';

  const gridFindings = useMemo(() => sortFindings(stream.findings), [stream.findings]);

  const skeletonCount = useMemo(() => {
    if (stream.status !== 'running') return 0;
    const running = Object.values(stream.lensState).filter(
      (s) => s === RUNNING,
    ).length;
    return Math.min(6, running * 2);
  }, [stream.status, stream.lensState]);

  const selected = useMemo(
    () => stream.findings.find((f) => f.id === selectedId) ?? null,
    [stream.findings, selectedId],
  );

  const progressCategories: RunProgressCategory[] = useMemo(
    () =>
      stream.requestedLenses.map((l) => ({
        key: l,
        label: LENS_META[l].label,
        icon: LENS_META[l].icon,
      })),
    [stream.requestedLenses],
  );

  const findingCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of stream.findings) {
      counts[f.lens] = (counts[f.lens] ?? 0) + 1;
    }
    return counts;
  }, [stream.findings]);

  const summary = useMemo(() => {
    const n = stream.requestedLenses.length;
    const parts = [
      stream.prNumber !== null ? `PR #${stream.prNumber}` : 'PR',
      stream.model ?? 'default',
      ...(config.effort != null ? [config.effort] : []),
      `${n} ${n === 1 ? 'lens' : 'lenses'}`,
    ];
    return `⌖ ${parts.join(' · ')}`;
  }, [stream.prNumber, stream.model, stream.requestedLenses, config.effort]);

  const runHistory: MenuItem[] = useMemo(
    () =>
      prReview.runs.map((run) => ({
        label: `PR #${run.prNumber} · ${new Date(run.createdAt).toLocaleString()} · ${run.findings.length} findings`,
        onClick: () => {
          setReconfiguring(false);
          resetBulk();
          setSelection(new Set());
          void prReview.selectRun(run.id);
        },
      })),
    [prReview, resetBulk],
  );

  const emptyMessage = useMemo(() => {
    if (stream.status === 'idle') {
      return 'Review a pull request to surface findings across the review lenses.';
    }
    if (stream.status === 'running') return 'Reviewing…';
    if (stream.status === 'failed') {
      if (stream.failureReason === 'aborted') return 'Review cancelled.';
      return `Review failed${stream.error !== null ? `: ${stream.error}` : ''}.`;
    }
    return 'No findings — the diff looks clean across the selected lenses.';
  }, [stream.status, stream.error, stream.failureReason]);

  const bulkStatusMessage = useMemo(() => {
    if (bulkConverting) return `Converting ${bulkDone + bulkFailed}/${bulkTotal}…`;
    if (bulkTotal === 0) return '';
    const ok = `Converted ${bulkDone} ${bulkDone === 1 ? 'finding' : 'findings'}`;
    return bulkFailed > 0 ? `${ok} (${bulkFailed} failed).` : `${ok}.`;
  }, [bulkConverting, bulkDone, bulkFailed, bulkTotal]);

  const bulkError = useMemo(() => {
    if (bulkConverting || bulkFailed === 0) return null;
    return `${bulkFailed} of ${bulkTotal} ${
      bulkTotal === 1 ? 'finding' : 'findings'
    } could not be converted.`;
  }, [bulkConverting, bulkFailed, bulkTotal]);

  const runAction = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setPending(true);
      try {
        await fn();
      } catch (err) {
        console.error(`${label} finding failed`, err);
        toast.error(`Could not ${label} finding`, err);
      } finally {
        setPending(false);
      }
    },
    [toast],
  );

  const onToggleSelect = useCallback((findingId: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(findingId)) next.delete(findingId);
      else next.add(findingId);
      return next;
    });
  }, []);

  // Dismiss also deselects — a dismissed finding must not be posted.
  const onDismiss = useCallback(
    (id: string) => {
      setSelection((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      void runAction('dismiss', () => prReview.dismiss(id));
    },
    [runAction, prReview],
  );

  const selectedFindings = useMemo(
    () => stream.findings.filter((f) => selection.has(f.id) && f.status !== 'dismissed'),
    [stream.findings, selection],
  );
  const selectedCount = selectedFindings.length;
  const selectedInlineCount = useMemo(
    () => selectedFindings.filter((f) => f.line !== null).length,
    [selectedFindings],
  );
  const canPost = stream.status === 'completed' && stream.prNumber !== null && selectedCount > 0;

  const requestPost = useCallback((verdict: ReviewVerdict) => {
    setPostError(null);
    setPostVerdict(verdict);
  }, []);

  const cancelPost = useCallback(() => {
    // Inert while a post is in flight (the dialog's Cancel is disabled too).
    if (postInFlight.current) return;
    setPostVerdict(null);
    setPostError(null);
  }, []);

  const confirmPost = useCallback(() => {
    if (postVerdict === null || postInFlight.current) return;
    if (stream.prNumber === null || selectedFindings.length === 0) return;
    const verdict = postVerdict;
    const prNumber = stream.prNumber;
    const body = composeReviewBody(verdict, selectedFindings);
    const comments = composeReviewComments(selectedFindings);
    postInFlight.current = true;
    setPosting(true);
    setPostError(null);
    void (async () => {
      try {
        await postReviewToGithub(prNumber, verdict, body, comments);
        toast.push({ tone: 'success', title: `Review posted to PR #${prNumber}` });
        setPostVerdict(null);
        setSelection(new Set());
      } catch (err) {
        // Surface BOTH inline (kept dialog) and via toast (the useToast discipline),
        // and keep the verdict open so the user can retry or cancel.
        console.error('postReviewToGithub failed', err);
        setPostError(err instanceof Error ? err.message : String(err));
        toast.error('Could not post the review', err);
      } finally {
        setPosting(false);
        postInFlight.current = false;
      }
    })();
  }, [postVerdict, stream.prNumber, selectedFindings, toast]);

  return {
    hasProject,
    projectName,
    stream,
    phase,
    config,
    summary,
    isStarting: prReview.isStarting,
    startError: prReview.startError,
    runHistory,
    hasHistory: prReview.runs.length > 0,
    progressCategories,
    findingCounts,
    gridFindings,
    skeletonCount,
    emptyMessage,
    selected,
    openFinding: (finding: ReviewFindingView) => setSelectedId(finding.id),
    closeFinding: () => setSelectedId(null),
    pending,
    onReview: () => {
      resetBulk();
      setSelection(new Set());
      // Leave the configure screen only once the run actually starts. start()
      // performs a synchronous `gh pr diff` fetch that rejects on common inputs
      // (missing PR, expired token, a run already in flight); on rejection it
      // sets startError and we STAY on configure so that banner is seen —
      // clearing reconfiguring eagerly would drop the view to the previous
      // run's stale results, where startError is never rendered.
      void (async () => {
        const started = await prReview.start(
          config.prNumberValue ?? 0,
          config.orderedSelected,
          config.model,
          config.effort,
        );
        if (started) setReconfiguring(false);
      })();
    },
    onCancel: () => void prReview.cancel(),
    startNewRun: () => {
      config.prefill({
        prNumber: stream.prNumber,
        model: stream.model,
        categories: stream.requestedLenses,
      });
      setReconfiguring(true);
    },
    convertAll: () => {
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
              await prReview.convert(f.id);
              setBulkDone((n) => n + 1);
            } catch (err) {
              console.error('convertReviewFindingToTask failed', err);
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
    onConvert: (id) => void runAction('convert', () => prReview.convert(id)),
    onDismiss,
    onRestore: (id) => void runAction('restore', () => prReview.restore(id)),
    onGotoBoard,
    selection,
    onToggleSelect,
    selectedCount,
    selectedInlineCount,
    canPost,
    postVerdict,
    posting,
    postError,
    requestPost,
    confirmPost,
    cancelPost,
  };
}
