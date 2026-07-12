/**
 * The live Insight reducer: folds the `analysis-*` event stream into a view model,
 * the same incremental-fold shape `session-stream.ts` uses for the board. Also
 * holds the normalizers that map the two finding sources — the live wire `Finding`
 * (contract) and the persisted `StoredFinding` (ts-rs) — into the single
 * `InsightFinding` the UI renders.
 */
import {
  AnalysisScopeSchema,
  FindingCategorySchema,
  FindingEffortSchema,
  FindingSeveritySchema,
} from '@nightcore/contracts';
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
  enumGuard,
  makeScanFold,
  narrowMembers,
  narrowOr,
  normalizeLocation,
  runStatusFromPersisted,
  seedStepStateFromRun,
} from '@/lib/scan-run';

import type { InsightFinding, RunStatus } from './insight.types';

/** A category's progress within a run. */
export type CategoryProgress = 'pending' | 'running' | 'done' | 'error';

/** Deep mode (issue #294): one category's round progress — the 1-based round index
 *  and how many net-new (post-dedup) findings that round contributed. Keyed by
 *  category in {@link InsightStream.categoryRounds}; a missing key means that
 *  category hasn't completed a round yet (classic single-pass runs never populate
 *  this map at all). */
export interface CategoryRoundInfo {
  round: number;
  newFindingsThisRound: number;
}

/** Membership guard for the web-local `FindingStatus` union (no contract schema),
 *  mirroring `insight.types.ts` exactly. */
const FINDING_STATUS = enumGuard(['open', 'dismissed', 'converted'] as const);

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
  /** Deep mode (issue #294): per-category round progress, keyed by category. Empty
   *  for a classic single-pass run (which never emits round events). */
  categoryRounds: Record<string, CategoryRoundInfo>;
}

export const EMPTY_INSIGHT_STREAM: InsightStream = {
  runId: null,
  status: 'idle',
  scope: null,
  model: null,
  requestedCategories: [],
  categoryState: {},
  findings: [],
  categoryRounds: {},
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
    location: normalizeLocation(f.location),
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
 *  the unified wire strings to their unions. The engine guarantees valid values on
 *  write, so a well-formed store maps unchanged; a corrupt value degrades to a
 *  documented fallback rather than leaking into the UI (see `@/lib/scan-run/narrow`). */
export function storedToFinding(f: StoredFinding): InsightFinding {
  return {
    id: f.id,
    // Fallback `refactor`: a neutral maintenance bucket (not the alarming
    // `security`/`bugs`) for an unrecognized category.
    category: narrowOr(FindingCategorySchema, f.category, 'refactor'),
    // Fallback `info`: the lowest severity — never over-escalate a bad value.
    severity: narrowOr(FindingSeveritySchema, f.severity, 'info'),
    // Fallback `medium`: a mid effort estimate.
    effort: narrowOr(FindingEffortSchema, f.effort, 'medium'),
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
    // Fallback `open`: the neutral active lifecycle state.
    status: narrowOr(FINDING_STATUS, f.status, 'open'),
    linkedTaskId: f.linkedTaskId,
  };
}

/** Project a persisted run into the same `InsightStream` shape the live fold
 *  produces, so the view renders both from one model. */
export function streamFromRun(run: InsightRun): InsightStream {
  const status: RunStatus = runStatusFromPersisted(run.status);
  // Drop any persisted category that isn't a contract member rather than seed a
  // bogus stepper lens.
  const categories = narrowMembers(FindingCategorySchema, run.categories);
  return {
    runId: run.id,
    status,
    // Fallback `repo`: the default full-repo scope for an unrecognized value.
    scope: narrowOr(AnalysisScopeSchema, run.scope, 'repo'),
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
    // Deep mode (issue #294): the persisted per-category round count survives
    // reconcile/resume; `newFindingsThisRound` isn't persisted (it's a
    // point-in-time delta), so a reloaded run reports 0 for it.
    categoryRounds: Object.fromEntries(
      Object.entries(run.roundsByCategory).map(([category, round]) => [
        category,
        { round, newFindingsThisRound: 0 },
      ]),
    ),
  };
}

/** Fold one `analysis-*` event into the live stream (the shared scan skeleton;
 *  see `makeScanFold` in `@/lib/scan-run`). */
export const foldInsight = makeScanFold<
  AnalysisEvent,
  InsightStream,
  InsightFinding,
  FindingCategory,
  AnalysisFailureReason
>({
  empty: EMPTY_INSIGHT_STREAM,
  steps: {
    state: (s) => s.categoryState,
    requested: (s) => s.requestedCategories,
  },
  items: { read: (s) => s.findings, stepOf: (f) => f.category },
  write: (s, patch) => ({
    ...s,
    ...patch.core,
    ...(patch.stepState === undefined
      ? undefined
      : { categoryState: patch.stepState }),
    ...(patch.requestedSteps === undefined
      ? undefined
      : { requestedCategories: patch.requestedSteps }),
    ...(patch.items === undefined ? undefined : { findings: patch.items }),
    ...patch.extra,
  }),
  classify: (event) => {
    switch (event.type) {
      case 'analysis-started':
        return {
          kind: 'started',
          runId: event.runId,
          model: event.model,
          steps: event.categories,
          seed: { scope: event.scope },
        };
      case 'analysis-category-started':
        return { kind: 'step-started', step: event.category };
      case 'analysis-category-completed':
        return {
          kind: 'step-completed',
          step: event.category,
          items: event.findings.map(wireToFinding),
          errored: Boolean(event.error),
          costUsd: event.costUsd,
          usage: event.usage,
        };
      // Deep mode (issue #294): one round of a category's multi-round loop finished.
      // `event.findings` is already the CUMULATIVE grounded set for that category
      // across every round so far, so this replaces (not appends to) the category's
      // slice of `findings` — the same replace-by-step shape `step-completed` uses,
      // via the `apply` escape hatch so the category stays `running` (more rounds
      // may still land; deep mode never emits a per-category terminal event).
      case 'analysis-category-round-completed':
        return {
          kind: 'apply',
          next: (prev) => ({
            ...prev,
            findings: [
              ...prev.findings.filter((f) => f.category !== event.category),
              ...event.findings.map(wireToFinding),
            ],
            costUsd: prev.costUsd + event.costUsd,
            usage: addUsage(prev.usage, event.usage),
            categoryRounds: {
              ...prev.categoryRounds,
              [event.category]: {
                round: event.round,
                newFindingsThisRound: event.newFindingsThisRound,
              },
            },
          }),
        };
      case 'analysis-completed':
        return {
          kind: 'completed',
          items: event.findings.map(wireToFinding),
          costUsd: event.costUsd,
          usage: event.usage,
          durationMs: event.durationMs,
        };
      case 'analysis-failed':
        return { kind: 'failed', message: event.message, reason: event.reason };
    }
  },
});
