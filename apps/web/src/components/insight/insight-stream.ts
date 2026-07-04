/**
 * The live Insight reducer: folds the `analysis-*` event stream into a view model,
 * the same incremental-fold shape `session-stream.ts` uses for the board. Also
 * holds the normalizers that map the two finding sources — the live wire `Finding`
 * (contract) and the persisted `StoredFinding` (ts-rs) — into the single
 * `InsightFinding` the UI renders.
 */
import type {
  AnalysisEvent,
  AnalysisScope,
  Finding,
  FindingCategory,
  InsightRun,
  StoredFinding,
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
  InsightFinding,
  RunStatus,
} from './insight.types';

/** A category's progress within a run. */
export type CategoryProgress = 'pending' | 'running' | 'done' | 'error';

/** The stable reason an `analysis-failed` event carries, threaded through the fold
 *  so the view can tell a user cancel (`aborted`) from a real crash. */
export type AnalysisFailureReason = Extract<
  AnalysisEvent,
  { type: 'analysis-failed' }
>['reason'];

export interface InsightStream {
  runId: string | null;
  status: RunStatus;
  scope: AnalysisScope | null;
  model: string | null;
  requestedCategories: FindingCategory[];
  categoryState: Record<string, CategoryProgress>;
  findings: InsightFinding[];
  costUsd: number;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
  error: string | null;
  /** Why the run failed, when `status === 'failed'`. Only set from the live
   *  `analysis-failed` event (a reloaded persisted run carries no reason). */
  failureReason: AnalysisFailureReason | null;
}

export const EMPTY_INSIGHT_STREAM: InsightStream = {
  runId: null,
  status: 'idle',
  scope: null,
  model: null,
  requestedCategories: [],
  categoryState: {},
  findings: [],
  costUsd: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
  durationMs: 0,
  error: null,
  failureReason: null,
};

/** Map a live wire `Finding` (contract) into the view shape — it is always `open`
 *  and unlinked when it streams in (lifecycle is applied on persist). */
export function wireToFinding(f: Finding): InsightFinding {
  return {
    id: f.id,
    category: f.category,
    severity: f.severity,
    effort: f.effort,
    title: f.title,
    description: f.description,
    rationale: f.rationale ?? null,
    location: f.location
      ? {
          file: f.location.file,
          startLine: f.location.startLine ?? null,
          endLine: f.location.endLine ?? null,
          symbol: f.location.symbol ?? null,
        }
      : null,
    suggestion: f.suggestion ?? null,
    codeBefore: f.codeBefore ?? null,
    codeAfter: f.codeAfter ?? null,
    affectedFiles: f.affectedFiles ?? [],
    tags: f.tags ?? [],
    confidence: f.confidence ?? null,
    fingerprint: f.fingerprint,
    status: 'open',
    linkedTaskId: null,
  };
}

/** Map a persisted `StoredFinding` (string-typed) into the view shape, narrowing
 *  the unified wire strings to their unions (the engine guarantees valid values). */
export function storedToFinding(f: StoredFinding): InsightFinding {
  return {
    id: f.id,
    category: f.category as InsightFinding['category'],
    severity: f.severity as InsightFinding['severity'],
    effort: f.effort as InsightFinding['effort'],
    title: f.title,
    description: f.description,
    rationale: f.rationale,
    location: f.location,
    suggestion: f.suggestion,
    codeBefore: f.codeBefore,
    codeAfter: f.codeAfter,
    affectedFiles: f.affectedFiles,
    tags: f.tags,
    confidence: f.confidence,
    fingerprint: f.fingerprint,
    status: f.status as FindingStatus,
    linkedTaskId: f.linkedTaskId,
  };
}

/** Project a persisted run into the same `InsightStream` shape the live fold
 *  produces, so the view renders both from one model. */
export function streamFromRun(run: InsightRun): InsightStream {
  const status: RunStatus = runStatusFromPersisted(run.status);
  const categories = run.categories as FindingCategory[];
  return {
    runId: run.id,
    status,
    scope: run.scope as AnalysisScope,
    model: run.model || null,
    requestedCategories: categories,
    categoryState: seedStepStateFromRun(categories, status === 'running'),
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

/** Fold one `analysis-*` event into the live stream. */
export function foldInsight(
  prev: InsightStream,
  event: AnalysisEvent,
): InsightStream {
  switch (event.type) {
    case 'analysis-started':
      return {
        ...EMPTY_INSIGHT_STREAM,
        runId: event.runId,
        status: 'running',
        scope: event.scope,
        model: event.model,
        requestedCategories: event.categories,
        categoryState: seedStepState(event.categories),
      };
    case 'analysis-category-started':
      return {
        ...prev,
        categoryState: { ...prev.categoryState, [event.category]: 'running' },
      };
    case 'analysis-category-completed': {
      const incoming = event.findings.map(wireToFinding);
      // Replace this category's optimistic findings with the completed batch.
      const others = prev.findings.filter((f) => f.category !== event.category);
      return {
        ...prev,
        categoryState: {
          ...prev.categoryState,
          [event.category]: event.error ? 'error' : 'done',
        },
        findings: [...others, ...incoming],
        costUsd: prev.costUsd + event.costUsd,
        usage: addUsage(prev.usage, event.usage),
      };
    }
    case 'analysis-completed':
      return {
        ...prev,
        status: 'completed',
        findings: event.findings.map(wireToFinding),
        costUsd: event.costUsd,
        usage: event.usage ?? prev.usage,
        durationMs: event.durationMs,
        categoryState: settleStepState(
          prev.requestedCategories,
          prev.categoryState,
        ),
      };
    case 'analysis-failed':
      return {
        ...prev,
        status: 'failed',
        error: event.message,
        failureReason: event.reason,
      };
  }
}
