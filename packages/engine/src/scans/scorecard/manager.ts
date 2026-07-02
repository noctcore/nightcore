/**
 * The Readiness Scorecard orchestrator (the Profile twin of {@link AnalysisManager}).
 * A thin {@link ScanManager} subclass: it fans out one READ-ONLY Claude pass per
 * production dimension (bounded-concurrent), each emitting a single grounded A–F
 * {@link ScorecardReading}, streams `scorecard-*` events, then emits a final
 * `scorecard-completed`. The dimension sub-sessions are INTERNAL: their ordinary
 * session events are consumed by the base runner and never reach the main event
 * stream — only `scorecard-*` events do.
 *
 * Degrade-not-throw throughout (inherited from the base): any crash surfaces as a
 * `scorecard-failed` event, never a rejected promise. The divergence from Insight is
 * only in the hooks below: a single reading per pass (wrapped as a 0-or-1 element
 * findings list so the generic pool/accumulate machinery is reused verbatim), a
 * different persona/toolset, and NO cross-dimension dedup — every scorecard run is a
 * fresh snapshot grade.
 */
import type {
  ScorecardDimension,
  ScorecardReading,
  SurfaceCommand,
} from '@nightcore/contracts';

import { ANALYZER_PERSONA } from '../shared/presets.js';
import {
  DEFAULT_MAX_TURNS,
  type FinalizeArgs,
  fmtCost,
  fmtElapsed,
  fmtSecs,
  type ItemCompletedArgs,
  type ScanFailureReason,
  ScanManager,
  type ScanManagerDeps,
  type ScanRunnerFactory,
  type ScanSessionRunner,
  type SessionConfigParts,
} from '../shared/scan-manager.js';
import {
  readingOutputContract,
  SCORECARD_ALLOWED_TOOLS,
  SCORECARD_DISALLOWED_TOOLS,
  type ScorecardPreset,
  scorecardPreset,
} from './presets.js';
import { groundReading, parseReading } from './readings.js';

/** The `start-scorecard` command variant (the zod schema is exported as a value, so
 *  the engine narrows the union for the type). */
type StartScorecard = Extract<SurfaceCommand, { type: 'start-scorecard' }>;

/** Evidence cap per dimension reading. */
const MAX_EVIDENCE_PER_DIMENSION = 8;

/** The runner factory + slice — REUSED from the generic base so the three managers
 *  share one fake-runner injection shape in tests. */
export type ScorecardRunnerFactory = ScanRunnerFactory;
export type ScorecardSessionRunner = ScanSessionRunner;
export type ScorecardManagerDeps = ScanManagerDeps;

export class ScorecardManager extends ScanManager<
  StartScorecard,
  ScorecardDimension,
  ScorecardPreset,
  ScorecardReading
> {
  protected items(command: StartScorecard): readonly ScorecardDimension[] {
    return command.dimensions;
  }

  protected preset(dimension: ScorecardDimension): ScorecardPreset {
    return scorecardPreset(dimension);
  }

  protected sessionConfig(
    command: StartScorecard,
    preset: ScorecardPreset,
  ): SessionConfigParts {
    return {
      appendSystemPrompt: `${ANALYZER_PERSONA} ${preset.rubric}`,
      allowedTools: [...SCORECARD_ALLOWED_TOOLS],
      disallowedTools: [...SCORECARD_DISALLOWED_TOOLS],
      maxTurns: command.maxTurnsPerDimension ?? DEFAULT_MAX_TURNS,
      ...(command.maxBudgetUsdPerDimension !== undefined
        ? { maxBudgetUsd: command.maxBudgetUsdPerDimension }
        : {}),
    };
  }

  protected heartbeatLabel(preset: ScorecardPreset): string {
    return `[scorecard:${preset.dimension}]`;
  }

  protected buildPrompt(
    command: StartScorecard,
    preset: ScorecardPreset,
    _context: Record<string, never>,
    inventory: string,
  ): string {
    return buildDimensionPrompt(command, preset, inventory);
  }

  /** A dimension pass yields ONE reading — normalized to a 0-or-1 element list so the
   *  generic pool/accumulate/retry machinery is reused unchanged. `error` is set (⇒
   *  the single corrective retry) exactly when no reading parsed, matching the old
   *  `parsed.reading === undefined` retry condition. */
  protected parse(
    result: string,
    dimension: ScorecardDimension,
  ): { findings: ScorecardReading[]; error?: string } {
    const parsed = parseReading(result, dimension);
    return {
      findings: parsed.reading !== undefined ? [parsed.reading] : [],
      ...(parsed.error !== undefined ? { error: parsed.error } : {}),
    };
  }

  protected ground(
    readings: ScorecardReading[],
    projectPath: string,
  ): ScorecardReading[] {
    return readings.map((r) => groundReading(r, projectPath));
  }

  protected retryReminderSuffix(): string {
    return '\n\nIMPORTANT: your previous answer was not valid JSON. Respond with ONLY the JSON object, nothing else.';
  }

  protected emitStarted(command: StartScorecard, model: string): void {
    this.deps.emit({
      type: 'scorecard-started',
      runId: command.runId,
      dimensions: command.dimensions,
      model,
    });
    this.deps.logger?.info(
      `[scorecard] grading started — ${command.dimensions.length} dimensions · model ${model}`,
    );
  }

  protected emitItemStarted(
    command: StartScorecard,
    dimension: ScorecardDimension,
  ): void {
    this.deps.emit({
      type: 'scorecard-dimension-started',
      runId: command.runId,
      dimension,
    });
    this.deps.logger?.info(`[scorecard] dimension ${dimension}: started`);
  }

  protected emitItemCompleted(
    args: ItemCompletedArgs<StartScorecard, ScorecardDimension, ScorecardReading>,
  ): void {
    const { command, item: dimension, grounded, outcome, elapsedMs } = args;
    const reading = grounded[0];
    this.deps.emit({
      type: 'scorecard-dimension-completed',
      runId: command.runId,
      dimension,
      ...(reading !== undefined ? { reading } : {}),
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });
    this.deps.logger?.info(
      `[scorecard] dimension ${dimension}: completed — ${
        reading !== undefined ? `grade ${reading.grade}` : 'ungraded'
      }, ${fmtCost(outcome.costUsd)}, ${fmtSecs(elapsedMs)}`,
    );
  }

  protected async finalize(
    args: FinalizeArgs<
      StartScorecard,
      ScorecardDimension,
      ScorecardReading,
      Record<string, never>
    >,
  ): Promise<void> {
    const { command, findings, itemsRun, totalCost, totalUsage, startedAt } = args;
    const durationMs = Date.now() - startedAt;
    this.deps.emit({
      type: 'scorecard-completed',
      runId: command.runId,
      readings: findings,
      dimensionsRun: itemsRun,
      costUsd: totalCost,
      durationMs,
      usage: totalUsage,
    });
    this.deps.logger?.info(
      `[scorecard] grading completed — ${findings.length} readings across ${itemsRun.length} dimensions, ${fmtCost(totalCost)}, ${fmtElapsed(durationMs)}`,
    );
  }

  protected emitFailed(
    command: StartScorecard,
    reason: ScanFailureReason,
    message: string,
  ): void {
    this.deps.emit({
      type: 'scorecard-failed',
      runId: command.runId,
      reason,
      message,
    });
  }

  protected cancelledMessage(): string {
    return 'scorecard cancelled';
  }
}

/** The per-run user prompt for a dimension pass. The deterministic top-level
 *  `inventory` is injected so the pass targets its reads from a known map. */
function buildDimensionPrompt(
  command: StartScorecard,
  preset: ScorecardPreset,
  inventory: string,
): string {
  return [
    `You are grading the project at: ${command.projectPath}`,
    `Dimension: ${preset.label}.`,
    '',
    'REPO MAP (deterministic top-level inventory — start here):',
    inventory,
    '',
    'Explore the relevant areas, then assign ONE letter grade for this dimension and',
    'back it with grounded evidence. Use the repo map to target your reads; do not',
    'spend turns re-listing the tree.',
    '',
    readingOutputContract(MAX_EVIDENCE_PER_DIMENSION),
  ].join('\n');
}
