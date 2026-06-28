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
    location: e.location
      ? {
          file: e.location.file,
          startLine: e.location.startLine ?? null,
          endLine: e.location.endLine ?? null,
          symbol: e.location.symbol ?? null,
        }
      : null,
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
    location: r.location
      ? {
          file: r.location.file,
          startLine: r.location.startLine ?? null,
          endLine: r.location.endLine ?? null,
          symbol: r.location.symbol ?? null,
        }
      : null,
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
    location: r.location
      ? {
          file: r.location.file,
          startLine: r.location.startLine ?? null,
          endLine: r.location.endLine ?? null,
          symbol: r.location.symbol ?? null,
        }
      : null,
    suggestion: r.suggestion,
    affectedFiles: r.affectedFiles,
    tags: r.tags,
    findings: r.findings.map((e) => ({
      detail: e.detail,
      location: e.location
        ? {
            file: e.location.file,
            startLine: e.location.startLine ?? null,
            endLine: e.location.endLine ?? null,
            symbol: e.location.symbol ?? null,
          }
        : null,
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
  const status: RunStatus =
    run.status === 'running'
      ? 'running'
      : run.status === 'failed'
        ? 'failed'
        : 'completed';
  const dimensions = run.dimensions as ScorecardDimension[];
  return {
    runId: run.id,
    status,
    model: run.model || null,
    requestedDimensions: dimensions,
    dimensionState: Object.fromEntries(
      dimensions.map((d) => [d, status === 'running' ? 'pending' : 'done']),
    ),
    readings: run.readings.map(storedToReading),
    costUsd: run.costUsd,
    usage: run.usage,
    durationMs: run.durationMs,
    error: run.error,
    failureReason: null,
  };
}

function addUsage(
  a: { inputTokens: number; outputTokens: number },
  b: { inputTokens: number; outputTokens: number } | undefined,
): { inputTokens: number; outputTokens: number } {
  if (b === undefined) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** Fold one `scorecard-*` event into the live stream. */
export function foldScorecard(
  prev: ScorecardStream,
  event: ScorecardWireEvent,
): ScorecardStream {
  switch (event.type) {
    case 'scorecard-started':
      return {
        ...EMPTY_SCORECARD_STREAM,
        runId: event.runId,
        status: 'running',
        model: event.model,
        requestedDimensions: event.dimensions,
        dimensionState: Object.fromEntries(
          event.dimensions.map((d) => [d, 'pending' as DimensionProgress]),
        ),
      };
    case 'scorecard-dimension-started':
      return {
        ...prev,
        dimensionState: { ...prev.dimensionState, [event.dimension]: 'running' },
      };
    case 'scorecard-dimension-completed': {
      // Replace this dimension's reading (if it graded) with the completed one.
      const others = prev.readings.filter((r) => r.dimension !== event.dimension);
      const incoming = event.reading ? [wireToReading(event.reading)] : [];
      return {
        ...prev,
        dimensionState: {
          ...prev.dimensionState,
          [event.dimension]: event.error ? 'error' : 'done',
        },
        readings: [...others, ...incoming],
        costUsd: prev.costUsd + event.costUsd,
        usage: addUsage(prev.usage, event.usage),
      };
    }
    case 'scorecard-completed':
      return {
        ...prev,
        status: 'completed',
        readings: event.readings.map(wireToReading),
        costUsd: event.costUsd,
        usage: event.usage ?? prev.usage,
        durationMs: event.durationMs,
        dimensionState: Object.fromEntries(
          prev.requestedDimensions.map((d) => [
            d,
            prev.dimensionState[d] === 'error' ? 'error' : 'done',
          ]),
        ),
      };
    case 'scorecard-failed':
      return {
        ...prev,
        status: 'failed',
        error: event.message,
        failureReason: event.reason,
      };
  }
}
