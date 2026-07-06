/**
 * The live Scorecard reducer: folds the `scorecard-*` event stream into a view
 * model, the Profile twin of `insight-stream.ts`'s `foldInsight`. Also holds the
 * normalizers that map the two reading sources — the live wire `ScorecardReading`
 * (contract) and the persisted `StoredReading` (ts-rs) — into the single
 * `ScorecardReadingView` the UI renders.
 */
import type {
  ScorecardDimension,
  ScorecardReading,
  ScorecardRun,
  ScorecardWireEvent,
  StoredReading,
} from '@/lib/bridge';
import {
  makeScanFold,
  normalizeLocation,
  runStatusFromPersisted,
  seedStepStateFromRun,
} from '@/lib/scan-run';

/** The live wire evidence shape (an element of a contract `ScorecardReading.findings`). */
type WireEvidence = ScorecardReading['findings'][number];
import type {
  ReadingStatus,
  RunStatus,
  ScorecardEvidenceView,
  ScorecardReadingView,
} from './scorecard.types';

/** A dimension's progress within a run. */
export type DimensionProgress = 'pending' | 'running' | 'done' | 'error';

/** The stable reason a `scorecard-failed` event carries, threaded through the fold
 *  so the view can tell a user cancel (`aborted`) from a real crash. */
export type ScorecardFailureReason = Extract<
  ScorecardWireEvent,
  { type: 'scorecard-failed' }
>['reason'];

/** The folded Scorecard view model: run identity/status, per-dimension progress,
 *  the normalized readings, and accrued cost/usage/duration. */
export interface ScorecardStream {
  runId: string | null;
  status: RunStatus;
  model: string | null;
  requestedDimensions: ScorecardDimension[];
  dimensionState: Record<string, DimensionProgress>;
  readings: ScorecardReadingView[];
  costUsd: number;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
  error: string | null;
  failureReason: ScorecardFailureReason | null;
}

/** The initial idle stream; the reset target for `scorecard-started`. */
export const EMPTY_SCORECARD_STREAM: ScorecardStream = {
  runId: null,
  status: 'idle',
  model: null,
  requestedDimensions: [],
  dimensionState: {},
  readings: [],
  costUsd: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
  durationMs: 0,
  error: null,
  failureReason: null,
};

function evidenceToView(e: WireEvidence): ScorecardEvidenceView {
  return {
    detail: e.detail,
    location: normalizeLocation(e.location),
  };
}

/** Map a live wire `ScorecardReading` (contract) into the view shape — it is always
 *  `open` and unlinked when it streams in (lifecycle is applied on persist). */
export function wireToReading(r: ScorecardReading): ScorecardReadingView {
  return {
    id: r.id,
    dimension: r.dimension,
    grade: r.grade,
    title: r.title,
    summary: r.summary,
    rationale: r.rationale ?? null,
    location: normalizeLocation(r.location),
    suggestion: r.suggestion ?? null,
    affectedFiles: r.affectedFiles ?? [],
    tags: r.tags ?? [],
    findings: (r.findings ?? []).map(evidenceToView),
    confidence: r.confidence ?? null,
    fingerprint: r.fingerprint,
    status: 'open',
    linkedTaskId: null,
  };
}

/** Map a persisted `StoredReading` (string-typed) into the view shape, narrowing the
 *  wire strings to their unions (the engine guarantees valid values). */
export function storedToReading(r: StoredReading): ScorecardReadingView {
  return {
    id: r.id,
    dimension: r.dimension as ScorecardReadingView['dimension'],
    grade: r.grade as ScorecardReadingView['grade'],
    title: r.title,
    summary: r.summary,
    rationale: r.rationale,
    location: normalizeLocation(r.location),
    suggestion: r.suggestion,
    affectedFiles: r.affectedFiles,
    tags: r.tags,
    findings: r.findings.map((e) => ({
      detail: e.detail,
      location: normalizeLocation(e.location),
    })),
    confidence: r.confidence,
    fingerprint: r.fingerprint,
    status: r.status as ReadingStatus,
    linkedTaskId: r.linkedTaskId,
  };
}

/** Project a persisted run into the same `ScorecardStream` shape the live fold
 *  produces, so the view renders both from one model. */
export function streamFromRun(run: ScorecardRun): ScorecardStream {
  const status: RunStatus = runStatusFromPersisted(run.status);
  const dimensions = run.dimensions as ScorecardDimension[];
  return {
    runId: run.id,
    status,
    model: run.model || null,
    requestedDimensions: dimensions,
    dimensionState: seedStepStateFromRun(dimensions, status === 'running'),
    readings: run.readings.map(storedToReading),
    costUsd: run.costUsd,
    usage: run.usage,
    durationMs: run.durationMs,
    error: run.error,
    failureReason: null,
  };
}

/** Fold one `scorecard-*` event into the live stream (the shared scan skeleton;
 *  see `makeScanFold` in `@/lib/scan-run`). */
export const foldScorecard = makeScanFold<
  ScorecardWireEvent,
  ScorecardStream,
  ScorecardReadingView,
  ScorecardDimension,
  ScorecardFailureReason
>({
  empty: EMPTY_SCORECARD_STREAM,
  steps: {
    state: (s) => s.dimensionState,
    requested: (s) => s.requestedDimensions,
  },
  items: { read: (s) => s.readings, stepOf: (r) => r.dimension },
  write: (s, patch) => ({
    ...s,
    ...patch.core,
    ...(patch.stepState === undefined
      ? undefined
      : { dimensionState: patch.stepState }),
    ...(patch.requestedSteps === undefined
      ? undefined
      : { requestedDimensions: patch.requestedSteps }),
    ...(patch.items === undefined ? undefined : { readings: patch.items }),
    ...patch.extra,
  }),
  classify: (event) => {
    switch (event.type) {
      case 'scorecard-started':
        return {
          kind: 'started',
          runId: event.runId,
          model: event.model,
          steps: event.dimensions,
        };
      case 'scorecard-dimension-started':
        return { kind: 'step-started', step: event.dimension };
      case 'scorecard-dimension-completed':
        return {
          kind: 'step-completed',
          step: event.dimension,
          // Replace this dimension's reading (if it graded) with the completed one.
          items: event.reading ? [wireToReading(event.reading)] : [],
          errored: Boolean(event.error),
          costUsd: event.costUsd,
          usage: event.usage,
        };
      case 'scorecard-completed':
        return {
          kind: 'completed',
          items: event.readings.map(wireToReading),
          costUsd: event.costUsd,
          usage: event.usage,
          durationMs: event.durationMs,
        };
      case 'scorecard-failed':
        return { kind: 'failed', message: event.message, reason: event.reason };
    }
  },
});
