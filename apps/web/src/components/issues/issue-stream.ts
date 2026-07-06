/**
 * The live Issue Triage reducer: folds the `issue-validation-*` event stream into a
 * view model, and projects a persisted `IssueValidationRun` into the same shape — the
 * incremental-fold pattern the scan siblings share (see `insight-stream.ts`). Unlike
 * the scan families this is ONE read-only session per run (no per-pass fan-out), so
 * the stream carries a single verdict rather than a list of findings.
 *
 * Also holds the normalizers that map the two verdict sources — the live wire
 * `IssueValidationResult` (contract, already union-typed) and the persisted
 * `StoredIssueValidationResult` (ts-rs, string-typed) — into the single
 * {@link IssueVerdictView} the UI renders.
 */
import type {
  IssueComplexity,
  IssueConfidence,
  IssueKind,
  IssuePrAnalysis,
  IssuePrRecommendation,
  IssueTriageEvent,
  IssueValidationResult,
  IssueValidationRun,
  IssueVerdict,
  StoredIssuePrAnalysis,
  StoredIssueValidationResult,
} from '@/lib/bridge';
import { makeScanFold, runStatusFromPersisted } from '@/lib/scan-run';

import type {
  IssuePrAnalysisView,
  IssueRunStatus,
  IssueVerdictView,
} from './issue-triage.types';

/** The folded view model for the single active/selected validation. Carries the
 *  `issueNumber` so the view can match the stream to the selected issue, and the run
 *  markers (`validatedAt` for staleness, `linkedTaskId` / `postedAt` for the action
 *  states). */
export interface IssueTriageStream {
  runId: string | null;
  issueNumber: number | null;
  status: IssueRunStatus;
  model: string | null;
  /** The latest human-readable progress note while running (else `null`). */
  progressMessage: string | null;
  result: IssueVerdictView | null;
  costUsd: number;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
  error: string | null;
  /** `'aborted'` for a user cancel vs a real failure — only set from the live
   *  `issue-validation-failed` event (a reloaded persisted run carries no reason). */
  failureReason: string | null;
  /** Epoch ms of the persisted run's last update (its `validatedAt`), for the
   *  staleness badge; `null` for a fresh/optimistic stream. */
  validatedAt: number | null;
  linkedTaskId: string | null;
  postedAt: number | null;
  postedCommentUrl: string | null;
}

export const EMPTY_ISSUE_TRIAGE_STREAM: IssueTriageStream = {
  runId: null,
  issueNumber: null,
  status: 'idle',
  model: null,
  progressMessage: null,
  result: null,
  costUsd: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
  durationMs: 0,
  error: null,
  failureReason: null,
  validatedAt: null,
  linkedTaskId: null,
  postedAt: null,
  postedCommentUrl: null,
};

/** Project a wire PR analysis (contract) into the view shape. */
function wirePrAnalysis(p: IssuePrAnalysis): IssuePrAnalysisView {
  return {
    hasOpenPr: p.hasOpenPr,
    prNumber: p.prNumber ?? null,
    prFixesIssue: p.prFixesIssue ?? null,
    prSummary: p.prSummary ?? null,
    recommendation: p.recommendation,
  };
}

/** Project a persisted PR analysis (string-typed ts-rs) into the view shape,
 *  narrowing the wire strings to their unions (the engine guarantees valid values). */
function storedPrAnalysis(p: StoredIssuePrAnalysis): IssuePrAnalysisView {
  return {
    hasOpenPr: p.hasOpenPr,
    prNumber: p.prNumber ?? null,
    prFixesIssue: p.prFixesIssue ?? null,
    prSummary: p.prSummary ?? null,
    recommendation: p.recommendation as IssuePrRecommendation,
  };
}

/** Map a live wire verdict (contract, already union-typed) into the view shape. */
export function wireToVerdict(r: IssueValidationResult): IssueVerdictView {
  return {
    issueKind: r.issueKind,
    verdict: r.verdict,
    confidence: r.confidence,
    reasoning: r.reasoning,
    bugConfirmed: r.bugConfirmed ?? null,
    relatedFiles: r.relatedFiles ?? [],
    estimatedComplexity: r.estimatedComplexity ?? null,
    proposedPlan: r.proposedPlan ?? null,
    missingInfo: r.missingInfo ?? [],
    prAnalysis: r.prAnalysis ? wirePrAnalysis(r.prAnalysis) : null,
  };
}

/** Map a persisted verdict (string-typed ts-rs) into the view shape, narrowing the
 *  unified wire strings to their unions (the engine guarantees valid values). */
export function storedToVerdict(r: StoredIssueValidationResult): IssueVerdictView {
  return {
    issueKind: r.issueKind as IssueKind,
    verdict: r.verdict as IssueVerdict,
    confidence: r.confidence as IssueConfidence,
    reasoning: r.reasoning,
    bugConfirmed: r.bugConfirmed ?? null,
    relatedFiles: r.relatedFiles,
    estimatedComplexity: (r.estimatedComplexity ?? null) as IssueComplexity | null,
    proposedPlan: r.proposedPlan ?? null,
    missingInfo: r.missingInfo,
    prAnalysis: r.prAnalysis ? storedPrAnalysis(r.prAnalysis) : null,
  };
}

/** Project a persisted run into the same `IssueTriageStream` the live fold produces,
 *  so the view renders both from one model. */
export function streamFromRun(run: IssueValidationRun): IssueTriageStream {
  return {
    runId: run.id,
    issueNumber: run.issueNumber,
    status: runStatusFromPersisted(run.status),
    model: run.model || null,
    progressMessage: null,
    result: run.result ? storedToVerdict(run.result) : null,
    costUsd: run.costUsd,
    usage: run.usage,
    durationMs: run.durationMs,
    error: run.error,
    // The persisted run records no failure reason — a reloaded failed run can't
    // distinguish a cancel from a crash, so it falls back to the generic banner.
    failureReason: null,
    validatedAt: run.updatedAt,
    linkedTaskId: run.linkedTaskId ?? null,
    postedAt: run.postedAt ?? null,
    postedCommentUrl: run.postedCommentUrl ?? null,
  };
}

/** Fold one `issue-validation-*` event into the live stream (the shared scan
 *  skeleton; see `makeScanFold` in `@/lib/scan-run`). Issue Triage is step-less
 *  and item-less — ONE read-only session per run — so the `steps` / `items`
 *  bindings are omitted and the single verdict rides the `extra` seams.
 *  `issue-validation-converted` is a no-op here (it is applied as a side effect
 *  in the view hook's `onEvent`). */
export const foldIssueTriage = makeScanFold<
  IssueTriageEvent,
  IssueTriageStream,
  never,
  string,
  string
>({
  empty: EMPTY_ISSUE_TRIAGE_STREAM,
  write: (s, patch) => ({
    ...s,
    ...patch.core,
    ...patch.extra,
  }),
  classify: (event) => {
    switch (event.type) {
      case 'issue-validation-started':
        return {
          kind: 'started',
          runId: event.runId,
          model: event.model,
          seed: { issueNumber: event.issueNumber },
        };
      case 'issue-validation-progress':
        return {
          kind: 'apply',
          next: (prev) => ({ ...prev, progressMessage: event.message }),
        };
      case 'issue-validation-completed':
        return {
          kind: 'completed',
          costUsd: event.costUsd,
          usage: event.usage,
          durationMs: event.durationMs,
          // A completed run authoritatively clears any prior failure state.
          extra: {
            issueNumber: event.issueNumber,
            result: wireToVerdict(event.result),
            error: null,
            failureReason: null,
          },
        };
      case 'issue-validation-failed':
        return { kind: 'failed', message: event.message, reason: event.reason };
      case 'issue-validation-converted':
        return { kind: 'ignore' };
    }
  },
});
