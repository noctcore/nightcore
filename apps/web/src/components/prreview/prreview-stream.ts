/**
 * The live PR Review reducer: folds the `pr-review-*` event stream into a view
 * model, the same incremental-fold shape `insight-stream.ts` uses. Also holds the
 * normalizers that map the two finding sources — the live wire `ReviewFinding`
 * (contract) and the persisted `StoredReviewFinding` (ts-rs) — into the single
 * `ReviewFindingView` the UI renders.
 */
import { ReviewLensSchema, ReviewSeveritySchema } from '@nightcore/contracts';
import type {
  PrReviewEvent,
  PrReviewRun,
  ReviewFinding,
  ReviewLens,
  StoredReviewFinding,
} from '@/lib/bridge';
import {
  addUsage,
  enumGuard,
  makeScanFold,
  narrowMembers,
  narrowOr,
  runStatusFromPersisted,
  seedStepStateFromRun,
} from '@/lib/scan-run';

import type { ReviewFindingView, RunStatus } from './prreview.types';

/** A lens's progress within a run. */
export type LensProgress = 'pending' | 'running' | 'done' | 'error';

/** Deep mode (issue #294): one lens's round progress — the 1-based round index and how
 *  many net-new (post-dedup) findings that round contributed. Keyed by lens in
 *  {@link ReviewStream.lensRounds}; a missing key means that lens hasn't completed a
 *  round yet (classic single-pass reviews never populate this map at all). Because the
 *  review is diff-bounded, a deep run self-limits (converges in a round or two). */
export interface LensRoundInfo {
  round: number;
  newFindingsThisRound: number;
}

/** Membership guard for the web-local `FindingStatus` union (no contract schema),
 *  mirroring `prreview.types.ts` exactly. */
const FINDING_STATUS = enumGuard(['open', 'dismissed', 'converted'] as const);

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
  /** What the ADVERSARIAL VALIDATOR dropped as unsupported by the diff — surfaced
   *  read-only so a silently-swallowed real finding stays visible. Never part of
   *  `findings`: these carry no lifecycle, never enter the post selection, and take
   *  no part in the verdict. Empty when it dropped nothing (or from an older run). */
  droppedFindings: ReviewFindingView[];
  /** Deep mode (issue #294): per-lens round progress, keyed by lens. Empty for a classic
   *  single-pass review (which never emits round events). */
  lensRounds: Record<string, LensRoundInfo>;
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
  droppedFindings: [],
  lensRounds: {},
  costUsd: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
  durationMs: 0,
  error: null,
  failureReason: null,
};

/** The lenses whose pass ERRORED in this run (`LensProgress === 'error'`), in the
 *  requested order. A run with any errored lens is DEGRADED: some lens's findings
 *  are missing, so the review is incomplete and must not read as a clean full
 *  review. Live-derived from the fold's per-lens state — a reloaded persisted run
 *  carries no per-lens error state (the store keeps only findings + cost), so this
 *  is empty after a reload (the review-run store does not yet persist which lenses
 *  errored). */
export function degradedLenses(stream: ReviewStream): ReviewLens[] {
  return stream.requestedLenses.filter((lens) => stream.lensState[lens] === 'error');
}

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
 *  narrowing the wire strings to their unions. The engine guarantees valid values on
 *  write, so a well-formed store maps unchanged; a corrupt value degrades to a
 *  documented fallback rather than leaking into the UI (see `@/lib/scan-run/narrow`). */
export function storedToFinding(f: StoredReviewFinding): ReviewFindingView {
  return {
    id: f.id,
    // Fallback `structure`: a general code-quality lens (not the alarming `security`)
    // for an unrecognized value.
    lens: narrowOr(ReviewLensSchema, f.lens, 'structure'),
    // Fallback `info`: the lowest severity — never over-escalate a bad value.
    severity: narrowOr(ReviewSeveritySchema, f.severity, 'info'),
    file: f.file,
    line: f.line,
    title: f.title,
    body: f.body,
    suggestedFix: f.suggestedFix,
    fingerprint: f.fingerprint,
    // Persisted as wire strings (like `lens`); drop any non-lens member, null → [].
    corroboratedBy: narrowMembers(ReviewLensSchema, f.corroboratedBy ?? []),
    // Fallback `open`: the neutral active lifecycle state.
    status: narrowOr(FINDING_STATUS, f.status, 'open'),
    linkedTaskId: f.linkedTaskId,
  };
}

/** Project a persisted run into the same `ReviewStream` shape the live fold
 *  produces, so the view renders both from one model. */
export function streamFromRun(run: PrReviewRun): ReviewStream {
  const status: RunStatus = runStatusFromPersisted(run.status);
  // Drop any persisted lens that isn't a contract member rather than seed a bogus
  // stepper lens.
  const lenses = narrowMembers(ReviewLensSchema, run.lenses);
  return {
    runId: run.id,
    status,
    prNumber: run.prNumber,
    model: run.model || null,
    requestedLenses: lenses,
    lensState: seedStepStateFromRun(lenses, status === 'running'),
    findings: run.findings.map(storedToFinding),
    // Additive on the persisted run: an older run file (or one whose validator
    // dropped nothing) reloads with an empty list.
    droppedFindings: (run.droppedFindings ?? []).map(storedToFinding),
    // Deep mode (issue #294): the persisted per-lens round count survives
    // reconcile/resume; `newFindingsThisRound` isn't persisted (a point-in-time delta),
    // so a reloaded run reports 0 for it.
    lensRounds: Object.fromEntries(
      Object.entries(run.roundsByLens).map(([lens, round]) => [
        lens,
        { round, newFindingsThisRound: 0 },
      ]),
    ),
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
      // Deep mode (issue #294): one round of a lens's multi-round loop finished.
      // `event.findings` is already the CUMULATIVE diff-grounded set for that lens across
      // every round so far, so this REPLACES (not appends to) the lens's slice of
      // `findings` — the same replace-by-step shape `step-completed` uses, via the
      // `apply` escape hatch so the lens stays `running` (more rounds may still land;
      // deep mode never emits a per-lens terminal event).
      case 'pr-review-round-completed':
        return {
          kind: 'apply',
          next: (prev) => ({
            ...prev,
            findings: [
              ...prev.findings.filter((f) => f.lens !== event.lens),
              ...event.findings.map(wireToFinding),
            ],
            costUsd: prev.costUsd + event.costUsd,
            usage: addUsage(prev.usage, event.usage),
            lensRounds: {
              ...prev.lensRounds,
              [event.lens]: {
                round: event.round,
                newFindingsThisRound: event.newFindingsThisRound,
              },
            },
          }),
        };
      case 'pr-review-completed':
        return {
          kind: 'completed',
          // The completed event carries the final cross-lens-deduped set.
          items: event.findings.map(wireToFinding),
          costUsd: event.costUsd,
          usage: event.usage,
          durationMs: event.durationMs,
          // Validator-drop visibility (#197): absent ⇒ nothing was dropped (or an
          // older engine), which reads as an empty list, never as stale data.
          extra: {
            droppedFindings: (event.droppedFindings ?? []).map(wireToFinding),
          },
        };
      case 'pr-review-failed':
        return { kind: 'failed', message: event.message, reason: event.reason };
    }
  },
});
