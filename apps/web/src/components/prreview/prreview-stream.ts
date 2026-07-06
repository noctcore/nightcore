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
  makeScanFold,
  runStatusFromPersisted,
  seedStepStateFromRun,
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
    // Absent when only the reporting lens found it (or an older engine) → [].
    corroboratedBy: f.corroboratedBy ?? [],
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
    // Persisted as wire strings (like `lens`); null when uncorroborated → [].
    corroboratedBy: (f.corroboratedBy as ReviewLens[] | null) ?? [],
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

/** Fold one `pr-review-*` lens event into the live stream (the shared scan
 *  skeleton; see `makeScanFold` in `@/lib/scan-run`). */
export const foldReview = makeScanFold<
  PrReviewLensEvent,
  ReviewStream,
  ReviewFindingView,
  ReviewLens,
  PrReviewFailureReason
>({
  empty: EMPTY_REVIEW_STREAM,
  steps: {
    state: (s) => s.lensState,
    requested: (s) => s.requestedLenses,
  },
  items: { read: (s) => s.findings, stepOf: (f) => f.lens },
  write: (s, patch) => ({
    ...s,
    ...patch.core,
    ...(patch.stepState === undefined ? undefined : { lensState: patch.stepState }),
    ...(patch.requestedSteps === undefined
      ? undefined
      : { requestedLenses: patch.requestedSteps }),
    ...(patch.items === undefined ? undefined : { findings: patch.items }),
    ...patch.extra,
  }),
  classify: (event, prev) => {
    switch (event.type) {
      case 'pr-review-started':
        return {
          kind: 'started',
          runId: event.runId,
          model: event.model,
          steps: event.lenses,
          // The started event omits the PR number — preserve the optimistically-
          // set one so the post-review toolbar keeps its target across the reset.
          seed: { prNumber: prev.prNumber },
        };
      case 'pr-review-lens-started':
        return { kind: 'step-started', step: event.lens };
      case 'pr-review-lens-completed':
        return {
          kind: 'step-completed',
          step: event.lens,
          items: event.findings.map(wireToFinding),
          errored: Boolean(event.error),
          costUsd: event.costUsd,
          usage: event.usage,
        };
      case 'pr-review-completed':
        return {
          kind: 'completed',
          // The completed event carries the final cross-lens-deduped set.
          items: event.findings.map(wireToFinding),
          costUsd: event.costUsd,
          usage: event.usage,
          durationMs: event.durationMs,
        };
      case 'pr-review-failed':
        return { kind: 'failed', message: event.message, reason: event.reason };
    }
  },
});
