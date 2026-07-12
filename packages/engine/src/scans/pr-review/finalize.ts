/**
 * The PR-review finalize tail, extracted from `manager.ts` so the orchestrator stays
 * under its file-size ratchet (the same split Harness/Insight used). Behavior is a pure
 * move — this runs for EVERY run (deep or classic), unchanged:
 *
 *   diff-ground across all lenses → cross-lens dedup (+corroboration) → adversarial
 *   validator pass → merge-verdict synthesis pass → emit `pr-review-completed`.
 *
 * Both tail passes are FAIL-OPEN and run silently (no event in the declared
 * `pr-review-*` family — only logs), and their usage/cost fold into the run totals:
 *  - the VALIDATOR keeps every finding on any error (we never lose a real finding to a
 *    flaky validator); a late cancel (mid-validation) surfaces `pr-review-failed`.
 *  - the VERDICT synthesis (after the validator, on the final survivors) never blocks:
 *    any error/timeout/cancel completes the run WITHOUT the verdict fields — so unlike
 *    the validator, a cancel here does NOT surface `pr-review-failed`.
 */
import type { ReviewFinding, ReviewLens } from '@nightcore/contracts';

import { fmtCost, fmtElapsed, fmtSecs } from '../shared/format.js';
import {
  addUsage,
  type FinalizeArgs,
  type ScanFailureReason,
  type ScanManagerDeps,
  type ScanRunnerFactory,
} from '../shared/scan-manager.js';
import { clampVerdict } from './clamp.js';
import {
  dedupePrReviewFindings,
  groundPrReviewFindings,
} from './findings.js';
import type { StartPrReview } from './manager.js';
import type { PrReviewContext } from './prompt.js';
import { validatePrReviewFindings } from './validator.js';
import { synthesizePrVerdict } from './verdict.js';

/** Everything the finalize tail needs, threaded from the manager (which owns the
 *  active-run registry + the `changedFilesByRun` cleanup). */
export interface FinalizePrReviewParams {
  deps: ScanManagerDeps;
  runnerFactory: ScanRunnerFactory;
  args: FinalizeArgs<StartPrReview, ReviewLens, ReviewFinding, PrReviewContext>;
  /** The manager's `emitFailed` (used on a mid-validation cancel). */
  emitFailed: (reason: ScanFailureReason, message: string) => void;
  /** The manager's cancel message. */
  cancelledMessage: string;
}

/** Run the PR-review finalize tail (see the module doc). */
export async function finalizePrReview({
  deps,
  runnerFactory,
  args,
  emitFailed,
  cancelledMessage,
}: FinalizePrReviewParams): Promise<void> {
  const { command, run, findings, itemsRun, totalUsage, startedAt, context } = args;
  let totalCost = args.totalCost;

  // Diff-relative grounding across every lens pass, then cross-lens dedup.
  const grounded = groundPrReviewFindings(findings, context.changedFiles);
  const deduped = dedupePrReviewFindings(grounded);

  deps.logger?.info(`[pr-review] validator: started — vetting ${deduped.length} findings`);
  const validatorStartedAt = Date.now();
  const validation = await validatePrReviewFindings({
    findings: deduped,
    diff: context.diff,
    changedFiles: context.changedFiles,
    command,
    config: deps.config,
    apiKeyFallback: deps.apiKeyFallback,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    runnerFactory,
    runners: run.runners,
    isCancelled: () => run.cancelled,
  });
  totalCost += validation.costUsd;
  addUsage(totalUsage, validation.usage);
  deps.logger?.info(
    `[pr-review] validator: completed — dropped ${validation.droppedIds.length} of ${deduped.length}, ${fmtCost(validation.costUsd)}, ${fmtSecs(Date.now() - validatorStartedAt)}`,
  );
  if (validation.error !== undefined && validation.error !== 'cancelled') {
    deps.logger?.warn('pr-review validator degraded; keeping all findings (fail-open)', {
      runId: command.runId,
      error: validation.error,
    });
  }

  if (run.cancelled) {
    emitFailed('aborted', cancelledMessage);
    return;
  }

  const survivors = validation.findings;

  // ONE additional read-only synthesis pass over the FINAL findings — the same
  // containment/machinery as the validator — that adjudicates an overall merge verdict.
  // FAIL-OPEN: any error/timeout/cancel completes WITHOUT the verdict fields.
  deps.logger?.info(`[pr-review] verdict: started — adjudicating ${survivors.length} findings`);
  const verdictStartedAt = Date.now();
  const verdict = await synthesizePrVerdict({
    findings: survivors,
    lensesRun: itemsRun,
    changedFiles: context.changedFiles,
    command,
    config: deps.config,
    apiKeyFallback: deps.apiKeyFallback,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    runnerFactory,
    runners: run.runners,
    isCancelled: () => run.cancelled,
  });
  totalCost += verdict.costUsd;
  addUsage(totalUsage, verdict.usage);
  deps.logger?.info(
    `[pr-review] verdict: completed — ${verdict.verdict ?? 'none'}, ${fmtCost(verdict.costUsd)}, ${fmtSecs(Date.now() - verdictStartedAt)}`,
  );
  if (verdict.error !== undefined && verdict.error !== 'cancelled') {
    deps.logger?.warn('pr-review verdict degraded; completing without a verdict (fail-open)', {
      runId: command.runId,
      error: verdict.error,
    });
  }

  // CLAMP the model's proposed verdict to the mechanical band derived from the FINAL
  // survivors' calibrated severities (clamp.ts). Fail-open: no model verdict ⇒ nothing
  // to clamp (we never synthesize one — the run completes without a verdict).
  const clamp =
    verdict.verdict !== undefined ? clampVerdict(verdict.verdict, survivors) : undefined;
  if (clamp?.clamped === true) {
    deps.logger?.info(`[pr-review] verdict clamped — ${clamp.reason}`);
  }

  const durationMs = Date.now() - startedAt;
  deps.emit({
    type: 'pr-review-completed',
    runId: command.runId,
    findings: survivors,
    lensesRun: itemsRun.length,
    costUsd: totalCost,
    durationMs,
    usage: totalUsage,
    ...(clamp !== undefined ? { verdict: clamp.verdict } : {}),
    ...(verdict.reasoning !== undefined ? { verdictReasoning: verdict.reasoning } : {}),
    ...(clamp?.clamped === true
      ? { verdictClamped: true, clampReason: clamp.reason }
      : {}),
  });
  deps.logger?.info(
    `[pr-review] review completed — ${survivors.length} findings across ${itemsRun.length} lenses${clamp !== undefined ? ` · verdict ${clamp.verdict}${clamp.clamped ? ' (clamped)' : ''}` : ''}, ${fmtCost(totalCost)}, ${fmtElapsed(durationMs)}`,
  );
}
