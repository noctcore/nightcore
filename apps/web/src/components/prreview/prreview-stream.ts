/**
 * The live PR Review reducer: folds the `pr-review-*` event stream into a view
 * model, the same incremental-fold shape `insight-stream.ts` uses. Also holds the
 * normalizers that map the two finding sources — the live wire `ReviewFinding`
 * (contract) and the persisted `StoredReviewFinding` (ts-rs) — into the single
 * `ReviewFindingView` the UI renders.
 */
import type {
  PrReviewEvent,
  PrReviewRun,
  ReviewFinding,
  ReviewLens,
  ReviewSeverity,
  StoredReviewFinding,
} from '@/lib/bridge';
import {
  addUsage,
  runStatusFromPersisted,
  seedStepState,
  seedStepStateFromRun,
  settleStepState,
} from '@/lib/scan-run';

import type {
  FindingStatus,
  ReviewFindingView,
  RunStatus,
} from './prreview.types';

/** A lens's progress within a run. */
export type LensProgress = 'pending' | 'running' | 'done' | 'error';

/** The `pr-review-*` events the stream folds — every family member EXCEPT the
 *  convert acknowledgement (that mutates a single finding's lifecycle and is
 *  applied directly in the hook, never through the fold). */
export type PrReviewLensEvent = Exclude<
  PrReviewEvent,
  { type: 'pr-review-finding-converted' }
>;

/** The reason a `pr-review-failed` event carries (a free string — the manager's
 *  failure code), threaded through the fold so the view can tell a user cancel
 *  (`aborted`) from a real crash. */
export type PrReviewFailureReason = Extract<
  PrReviewLensEvent,
  { type: 'pr-review-failed' }
>['reason'];

export interface ReviewStream {
  runId: string | null;
  status: RunStatus;
  /** The reviewed PR number — carried from the optimistic start (the started
   *  event omits it) or a reloaded persisted run, so the post-review toolbar and
   *  summary always know which PR they act on. */
  prNumber: number | null;
  model: string | null;
  requestedLenses: ReviewLens[];
  lensState: Record<string, LensProgress>;
  findings: ReviewFindingView[];
  costUsd: number;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
  error: string | null;
  /** Why the run failed, when `status === 'failed'`. Only set from the live
   *  `pr-review-failed` event (a reloaded persisted run carries no reason). */
  failureReason: PrReviewFailureReason | null;
}

export const EMPTY_REVIEW_STREAM: ReviewStream = {
  runId: null,
  status: 'idle',
  prNumber: null,
  model: null,
  requestedLenses: [],
  lensState: {},
  findings: [],
  costUsd: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
  durationMs: 0,
  error: null,
  failureReason: null,
};

/** Map a live wire `ReviewFinding` (contract) into the view shape — it is always
 *  `open` and unlinked when it streams in (lifecycle is applied on persist). */
export function wireToFinding(f: ReviewFinding): ReviewFindingView {
  return {
    id: f.id,
    lens: f.lens,
    severity: f.severity,
    file: f.file,
    line: f.line ?? null,
    title: f.title,
    body: f.body,
    suggestedFix: f.suggestedFix ?? null,
    fingerprint: f.fingerprint,
    status: 'open',
    linkedTaskId: null,
  };
}

/** Map a persisted `StoredReviewFinding` (string-typed) into the view shape,
 *  narrowing the wire strings to their unions (the engine guarantees valid values). */
export function storedToFinding(f: StoredReviewFinding): ReviewFindingView {
  return {
    id: f.id,
    lens: f.lens as ReviewLens,
    severity: f.severity as ReviewSeverity,
    file: f.file,
    line: f.line,
    title: f.title,
    body: f.body,
    suggestedFix: f.suggestedFix,
    fingerprint: f.fingerprint,
    status: f.status as FindingStatus,
    linkedTaskId: f.linkedTaskId,
  };
}

/** Project a persisted run into the same `ReviewStream` shape the live fold
 *  produces, so the view renders both from one model. */
export function streamFromRun(run: PrReviewRun): ReviewStream {
  const status: RunStatus = runStatusFromPersisted(run.status);
  const lenses = run.lenses as ReviewLens[];
  return {
    runId: run.id,
    status,
    prNumber: run.prNumber,
    model: run.model || null,
    requestedLenses: lenses,
    lensState: seedStepStateFromRun(lenses, status === 'running'),
    findings: run.findings.map(storedToFinding),
    costUsd: run.costUsd,
    usage: run.usage,
    durationMs: run.durationMs,
    error: run.error,
    // The persisted run records no failure reason — a reloaded failed run can't
    // distinguish a cancel from a crash, so it falls back to the generic banner.
    failureReason: null,
  };
}

/** Fold one `pr-review-*` lens event into the live stream. */
export function foldReview(
  prev: ReviewStream,
  event: PrReviewLensEvent,
): ReviewStream {
  switch (event.type) {
    case 'pr-review-started':
      return {
        ...EMPTY_REVIEW_STREAM,
        // The started event omits the PR number — preserve the optimistically-set
        // one so the post-review toolbar keeps its target across the reset.
        prNumber: prev.prNumber,
        runId: event.runId,
        status: 'running',
        model: event.model,
        requestedLenses: event.lenses,
        lensState: seedStepState(event.lenses),
      };
    case 'pr-review-lens-started':
      return {
        ...prev,
        lensState: { ...prev.lensState, [event.lens]: 'running' },
      };
    case 'pr-review-lens-completed': {
      const incoming = event.findings.map(wireToFinding);
      // Replace this lens's optimistic findings with the completed batch.
      const others = prev.findings.filter((f) => f.lens !== event.lens);
      return {
        ...prev,
        lensState: {
          ...prev.lensState,
          [event.lens]: event.error ? 'error' : 'done',
        },
        findings: [...others, ...incoming],
        costUsd: prev.costUsd + event.costUsd,
        usage: addUsage(prev.usage, event.usage),
      };
    }
    case 'pr-review-completed':
      return {
        ...prev,
        status: 'completed',
        // The completed event carries the final cross-lens-deduped set.
        findings: event.findings.map(wireToFinding),
        costUsd: event.costUsd,
        usage: event.usage ?? prev.usage,
        durationMs: event.durationMs,
        lensState: settleStepState(prev.requestedLenses, prev.lensState),
      };
    case 'pr-review-failed':
      return {
        ...prev,
        status: 'failed',
        error: event.message,
        failureReason: event.reason,
      };
  }
}
