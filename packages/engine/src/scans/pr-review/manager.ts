/**
 * The PR Review orchestrator — the fourth {@link ScanManager} sibling. It fans out one
 * READ-ONLY Claude pass per review LENS (bounded-concurrent) over the PR DIFF, parses
 * + DIFF-GROUNDS each pass's findings via the pure helpers, streams `pr-review-*`
 * events, then de-dups across lenses and runs ONE adversarial validator pass that
 * drops false positives before emitting the terminal `pr-review-completed`. The lens +
 * validator sub-sessions are INTERNAL: their ordinary session events are consumed by
 * the base runner and never reach the main event stream — only `pr-review-*` events do.
 *
 * Like the other siblings it inherits ALL the run mechanics (active-run registry,
 * bounded pool, per-item corrective retry, `runOneSession`, usage accumulation,
 * cancel/crash handling) from {@link ScanManager}; this class injects only the
 * PR-Review-specific pieces. Divergences from Insight:
 *  - `prepare()` captures the Rust-resolved diff + changed-file set (NO shell-out —
 *    the sidecar is network-free).
 *  - grounding is DIFF-RELATIVE (a finding's `file` must be a changed file), which the
 *    base's `ground(findings, projectPath)` hook can't express (it only threads
 *    projectPath, for disk-grounding features) — so it is applied per-run in
 *    `emitItemCompleted` + `finalize`; see `ground()` below.
 *  - `finalize()` adds a Harness-style tail: an adversarial validator pass (fail-open).
 *
 * Degrade-not-throw throughout (inherited): any crash surfaces as `pr-review-failed`,
 * never a rejected promise; a flaky validator degrades to keeping every finding.
 */
import type {
  ReviewFinding,
  ReviewLens,
  SurfaceCommand,
} from '@nightcore/contracts';

import { fmtCost, fmtSecs } from '../shared/format.js';
import {
  DEFAULT_MAX_TURNS,
  type FinalizeArgs,
  type ItemCompletedArgs,
  RETRY_REMINDER_ARRAY,
  type RoundCompletedInfo,
  type ScanFailureReason,
  ScanManager,
  type ScanManagerDeps,
  type ScanRunnerFactory,
  type ScanSessionRunner,
  type SessionConfigParts,
} from '../shared/scan-manager.js';
import { finalizePrReview } from './finalize.js';
import {
  findingsFromStructuredOutput,
  groundPrReviewFindings,
  parsePrReviewFindings,
  PR_REVIEW_OUTPUT_FORMAT,
} from './findings.js';
import {
  PR_REVIEW_ALLOWED_TOOLS,
  PR_REVIEW_DISALLOWED_TOOLS,
  PR_REVIEWER_PERSONA,
  type PrReviewPreset,
  prReviewPreset,
} from './presets.js';
import {
  buildLensPrompt,
  MAX_FINDINGS_PER_LENS,
  type PrReviewContext,
} from './prompt.js';

/** The `start-pr-review` command variant (the zod schema is exported as a value, so
 *  the engine narrows the union for the type). Exported so the extracted finalize tail
 *  ({@link finalizePrReview}) narrows the same variant without a manager⇄finalize cycle. */
export type StartPrReview = Extract<SurfaceCommand, { type: 'start-pr-review' }>;

/** The runner factory + slice — REUSED from the generic base so the managers share one
 *  fake-runner injection shape in tests. */
export type PrReviewRunnerFactory = ScanRunnerFactory;
export type PrReviewSessionRunner = ScanSessionRunner;
export type PrReviewManagerDeps = ScanManagerDeps;

export class PrReviewScanManager extends ScanManager<
  StartPrReview,
  ReviewLens,
  PrReviewPreset,
  ReviewFinding,
  PrReviewContext
> {
  /**
   * The PR changed-file set per ACTIVE run, keyed by `runId`. Needed because the base's
   * `ground(findings, projectPath)` hook only threads `projectPath` (built for
   * disk-grounding features), not the run's changed-file set — and the manager can run
   * multiple `runId`s concurrently on one instance, so a single instance field would
   * race between runs. The per-lens diff-relative grounding reads this map by `runId`
   * (which `emitItemCompleted` has via `command`); the final grounding uses the
   * per-call `context` instead. Entries are removed on any terminal path.
   */
  private readonly changedFilesByRun = new Map<string, string[]>();

  protected items(command: StartPrReview): readonly ReviewLens[] {
    return command.lenses;
  }

  /** No session, no shell-out: the Rust core already ran `gh pr diff <n>` (+
   *  `--name-only`), capped the diff, and passed both on the command. Just capture them
   *  for the prompts + grounding. */
  protected async prepare(command: StartPrReview): Promise<PrReviewContext> {
    this.changedFilesByRun.set(command.runId, command.changedFiles);
    return { diff: command.diff, changedFiles: command.changedFiles };
  }

  protected preset(lens: ReviewLens): PrReviewPreset {
    return prReviewPreset(lens);
  }

  protected sessionConfig(
    _command: StartPrReview,
    preset: PrReviewPreset,
  ): SessionConfigParts {
    return {
      appendSystemPrompt: `${PR_REVIEWER_PERSONA} For this pass, review the PR for: ${preset.focus}`,
      allowedTools: [...PR_REVIEW_ALLOWED_TOOLS],
      disallowedTools: [...PR_REVIEW_DISALLOWED_TOOLS],
      maxTurns: DEFAULT_MAX_TURNS,
      // Enforced structured output so each finding's `severity` is a validated enum (the
      // substrate the verdict clamp bands on); the parse below degrades to text.
      outputFormat: PR_REVIEW_OUTPUT_FORMAT,
    };
  }

  protected heartbeatLabel(preset: PrReviewPreset): string {
    return `[pr-review:${preset.lens}]`;
  }

  protected buildPrompt(
    command: StartPrReview,
    preset: PrReviewPreset,
    context: PrReviewContext,
    inventory: string,
  ): string {
    return buildLensPrompt(command, preset, context, inventory);
  }

  /** Deep mode (issue #294): round 1 caps at `maxFindingsPerRound`; round ≥ 2 appends
   *  the exclusion list of `foundSoFar` and flips the output contract to "NEW findings
   *  not already listed above". The review is DIFF-BOUNDED — the changed-file set is
   *  fixed and small — so this loop SELF-LIMITS: it converges in a round or two once
   *  the diff is exhausted, rather than open-endedly (that is expected, not a bug). */
  protected buildRoundPrompt(
    command: StartPrReview,
    preset: PrReviewPreset,
    context: PrReviewContext,
    inventory: string,
    _round: number,
    foundSoFar: readonly ReviewFinding[],
  ): string {
    return buildLensPrompt(
      command,
      preset,
      context,
      inventory,
      command.deep?.maxFindingsPerRound ?? MAX_FINDINGS_PER_LENS,
      foundSoFar,
    );
  }

  /** Deep mode: net-new across rounds keys on the SAME lens-scoped `fingerprint` the
   *  cross-lens `dedupePrReviewFindings` (and the Rust dismissed/convert history) use. */
  protected deepFingerprint(finding: ReviewFinding): string {
    return finding.fingerprint;
  }

  /** Deep mode: ground each round DIFF-RELATIVE against this run's changed-file set,
   *  so the round loop's net-new count and the round event's cumulative set are both
   *  grounded (the base `ground` hook is a passthrough — it can't thread `changedFiles`;
   *  the deep `context` carries them). Idempotent with the finalize re-grounding. */
  protected deepGround(
    _command: StartPrReview,
    context: PrReviewContext,
    findings: ReviewFinding[],
  ): ReviewFinding[] {
    return groundPrReviewFindings(findings, context.changedFiles);
  }

  protected parse(
    result: string,
    lens: ReviewLens,
    structuredOutput?: Record<string, unknown>,
  ): { findings: ReviewFinding[]; error?: string } {
    // PREFER validated structured output; degrade to prose-parsing the result text when
    // it is ABSENT (older/degraded run, or the Codex path). A structured pass with zero
    // findings is a clean lens, never a parse error, so it never drives the retry.
    const structured = findingsFromStructuredOutput(structuredOutput, lens);
    if (structured !== undefined) return { findings: structured };
    return parsePrReviewFindings(result, lens);
  }

  /**
   * Passthrough. Diff-relative grounding needs the PR's changed-file set, which the
   * base's `ground` hook does not thread (it passes only `projectPath`). The real
   * grounding is applied where the changed-file set IS available: per-lens in
   * `emitItemCompleted` (keyed by `runId`) and across all lenses in `finalize` (via the
   * per-call `context`). Returning the findings unchanged here keeps the base's
   * accumulation intact so `finalize` grounds the full set once. (The base's
   * `projectPath` arg is intentionally omitted — it is not the axis PR review grounds on.)
   */
  protected ground(findings: ReviewFinding[]): ReviewFinding[] {
    return findings;
  }

  protected retryReminderSuffix(): string {
    return RETRY_REMINDER_ARRAY;
  }

  protected emitStarted(command: StartPrReview, model: string): void {
    this.deps.emit({
      type: 'pr-review-started',
      runId: command.runId,
      lenses: command.lenses,
      model,
    });
    this.deps.logger?.info(
      `[pr-review] review started — PR #${command.prNumber} · ${command.lenses.length} lenses · ${command.changedFiles.length} changed files · model ${model}`,
    );
  }

  protected emitItemStarted(command: StartPrReview, lens: ReviewLens): void {
    this.deps.emit({ type: 'pr-review-lens-started', runId: command.runId, lens });
    this.deps.logger?.info(`[pr-review] lens ${lens}: started`);
  }

  protected emitItemCompleted(
    args: ItemCompletedArgs<StartPrReview, ReviewLens, ReviewFinding>,
  ): void {
    const { command, item: lens, grounded, outcome, elapsedMs } = args;
    // `grounded` is the base's passthrough (see `ground`); apply the diff-relative
    // filter here with THIS run's changed-file set so the streamed batch is grounded.
    const changedFiles = this.changedFilesByRun.get(command.runId) ?? [];
    const findings = groundPrReviewFindings(grounded, changedFiles);
    this.deps.emit({
      type: 'pr-review-lens-completed',
      runId: command.runId,
      lens,
      findings,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });
    this.deps.logger?.info(
      `[pr-review] lens ${lens}: completed — ${findings.length} findings, ${fmtCost(outcome.costUsd)}, ${fmtSecs(elapsedMs)}`,
    );
  }

  /** Deep mode: one round of a lens finished. `info.cumulative` is already
   *  diff-grounded (see `deepGround`), so it streams the cumulative diff-grounded
   *  findings + this round's own spend; the Rust reader persists per ROUND. */
  protected emitRoundCompleted(
    command: StartPrReview,
    lens: ReviewLens,
    info: RoundCompletedInfo<ReviewFinding>,
  ): void {
    this.deps.emit({
      type: 'pr-review-round-completed',
      runId: command.runId,
      lens,
      round: info.round,
      newFindingsThisRound: info.newFindingsThisRound,
      findings: info.cumulative,
      usage: info.outcome.usage,
      costUsd: info.outcome.costUsd,
      durationMs: info.elapsedMs,
    });
    this.deps.logger?.info(
      `[pr-review] lens ${lens}: round ${info.round} — ${info.newFindingsThisRound} new (${info.cumulative.length} total), ${fmtCost(info.outcome.costUsd)}, ${fmtSecs(info.elapsedMs)}`,
    );
  }

  /**
   * Diff-ground across all lenses → cross-lens dedup (+corroboration) → adversarial
   * validator pass → merge-verdict synthesis pass → complete. The whole tail lives in
   * {@link finalizePrReview} (extracted for the file-size ratchet); this is the thin
   * wrapper that threads the manager's deps + `emitFailed` and, on EVERY terminal path,
   * clears this run's changed-file set so it never leaks.
   */
  protected async finalize(
    args: FinalizeArgs<StartPrReview, ReviewLens, ReviewFinding, PrReviewContext>,
  ): Promise<void> {
    try {
      await finalizePrReview({
        deps: this.deps,
        runnerFactory: this.runnerFactory,
        args,
        emitFailed: (reason, message) =>
          this.emitFailed(args.command, reason, message),
        cancelledMessage: this.cancelledMessage(),
      });
    } finally {
      this.changedFilesByRun.delete(args.command.runId);
    }
  }

  protected emitFailed(
    command: StartPrReview,
    reason: ScanFailureReason,
    message: string,
  ): void {
    // Terminal on every failure path (base's cancel/crash + finalize's late cancel) —
    // clear the per-run changed-file set here so it never leaks.
    this.changedFilesByRun.delete(command.runId);
    this.deps.emit({
      type: 'pr-review-failed',
      runId: command.runId,
      reason,
      message,
    });
  }

  protected cancelledMessage(): string {
    return 'pr review cancelled';
  }
}
