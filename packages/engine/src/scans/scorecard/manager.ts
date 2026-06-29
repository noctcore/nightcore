/**
 * The Readiness Scorecard orchestrator (the Profile twin of {@link AnalysisManager}).
 * Fans out one READ-ONLY Claude pass per production dimension (bounded-concurrent),
 * each emitting a single grounded A–F {@link ScorecardReading}, streams
 * `scorecard-*` events, then emits a final `scorecard-completed`. The dimension
 * sub-sessions are INTERNAL: their ordinary session events are consumed here and
 * never reach the main event stream — only `scorecard-*` events do.
 *
 * Degrade-not-throw throughout: any crash surfaces as a `scorecard-failed` event,
 * never a rejected promise. The bounded-concurrency pool, repo inventory, and
 * heartbeat are reused from the Insight orchestrator; the divergence is
 * `runDimension` (grades, not finds) + `parseReading`/`groundReading`.
 */
import type {
  Config,
  NightcoreEvent,
  ScorecardDimension,
  ScorecardReading,
  SurfaceCommand,
  TokenUsage,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';
import { SessionRunner } from '../../session/session-runner.js';
import {
  buildRepoInventory,
  fmtCost,
  fmtElapsed,
  fmtSecs,
  makeHeartbeat,
  runPool,
  type AnalysisRunnerFactory,
  type AnalysisSessionRunner,
} from '../shared/manager.js';
import { ANALYZER_PERSONA } from '../shared/presets.js';
import {
  readingOutputContract,
  scorecardPreset,
  SCORECARD_ALLOWED_TOOLS,
  SCORECARD_DISALLOWED_TOOLS,
  type ScorecardPreset,
} from './presets.js';
import { groundReading, parseReading } from './readings.js';

/** The `start-scorecard` command variant (the zod schema is exported as a value,
 *  so the engine narrows the union for the type). */
type StartScorecard = Extract<SurfaceCommand, { type: 'start-scorecard' }>;

/** Default number of dimension passes to run at once (mirrors Insight's 6). The
 *  pool caps this at `dimensions.length`; `command.maxConcurrency` overrides it. */
const DEFAULT_CONCURRENCY = 6;
/** Per-dimension turn ceiling (explore then write the reading). */
const DEFAULT_MAX_TURNS = 40;
/** Evidence cap per dimension reading. */
const MAX_EVIDENCE_PER_DIMENSION = 8;

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** The stable failure reason carried by a `session-failed` event. */
type SessionFailedReason = Extract<
  NightcoreEvent,
  { type: 'session-failed' }
>['reason'];

/** The runner factory + slice the orchestrator drives — REUSED from the Insight
 *  orchestrator so the three managers share one fake-runner injection shape. */
export type ScorecardRunnerFactory = AnalysisRunnerFactory;
export type ScorecardSessionRunner = AnalysisSessionRunner;

const defaultRunnerFactory: ScorecardRunnerFactory = (config, emit, logger) =>
  new SessionRunner(config, emit, logger);

export interface ScorecardManagerDeps {
  config: Config;
  apiKeyFallback: boolean;
  emit: (event: NightcoreEvent) => void;
  logger?: Logger;
  /** Override the per-dimension runner construction (tests inject a fake). */
  runnerFactory?: ScorecardRunnerFactory;
}

interface ActiveRun {
  runId: string;
  runners: Set<ScorecardSessionRunner>;
  cancelled: boolean;
}

interface DimensionOutcome {
  reading?: ScorecardReading;
  usage: TokenUsage;
  costUsd: number;
  error?: string;
  reason?: SessionFailedReason;
}

export class ScorecardManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly runnerFactory: ScorecardRunnerFactory;

  constructor(private readonly deps: ScorecardManagerDeps) {
    this.runnerFactory = deps.runnerFactory ?? defaultRunnerFactory;
  }

  /** Start a run. Fire-and-forget: failures surface as a `scorecard-failed` event,
   *  never a rejected promise (degrade-not-throw, like the AnalysisManager). */
  start(command: StartScorecard): void {
    if (this.active.has(command.runId)) {
      this.deps.logger?.debug('scorecard run already active; ignoring start', {
        runId: command.runId,
      });
      return;
    }
    void this.runScorecard(command);
  }

  /** Cancel an in-flight run: abort every live dimension pass. */
  cancel(runId: string): void {
    const run = this.active.get(runId);
    if (run === undefined) return;
    run.cancelled = true;
    for (const runner of run.runners) {
      void runner.interrupt();
    }
  }

  private async runScorecard(command: StartScorecard): Promise<void> {
    const { emit } = this.deps;
    const run: ActiveRun = {
      runId: command.runId,
      runners: new Set(),
      cancelled: false,
    };
    this.active.set(command.runId, run);
    const startedAt = Date.now();

    const model = command.model ?? this.deps.config.model;
    emit({
      type: 'scorecard-started',
      runId: command.runId,
      dimensions: command.dimensions,
      model,
    });
    this.deps.logger?.info(
      `[scorecard] grading started — ${command.dimensions.length} dimensions · model ${model}`,
    );

    const readings: ScorecardReading[] = [];
    const dimensionsRun: ScorecardDimension[] = [];
    let totalCost = 0;
    const totalUsage: TokenUsage = { ...EMPTY_USAGE };
    const inventory = buildRepoInventory(command.projectPath);

    try {
      await runPool(
        command.dimensions,
        command.maxConcurrency ?? DEFAULT_CONCURRENCY,
        async (dimension) => {
          if (run.cancelled) return;
          const dimensionStartedAt = Date.now();
          emit({
            type: 'scorecard-dimension-started',
            runId: command.runId,
            dimension,
          });
          this.deps.logger?.info(`[scorecard] dimension ${dimension}: started`);

          const outcome = await this.runDimension(
            command,
            dimension,
            run,
            inventory,
          );
          if (run.cancelled) return;

          const grounded =
            outcome.reading !== undefined
              ? groundReading(outcome.reading, command.projectPath)
              : undefined;
          dimensionsRun.push(dimension);
          totalCost += outcome.costUsd;
          addUsage(totalUsage, outcome.usage);
          if (grounded !== undefined) readings.push(grounded);

          emit({
            type: 'scorecard-dimension-completed',
            runId: command.runId,
            dimension,
            ...(grounded !== undefined ? { reading: grounded } : {}),
            usage: outcome.usage,
            costUsd: outcome.costUsd,
            ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          });
          this.deps.logger?.info(
            `[scorecard] dimension ${dimension}: completed — ${
              grounded !== undefined ? `grade ${grounded.grade}` : 'ungraded'
            }, ${fmtCost(outcome.costUsd)}, ${fmtSecs(Date.now() - dimensionStartedAt)}`,
          );
        },
      );

      if (run.cancelled) {
        emit({
          type: 'scorecard-failed',
          runId: command.runId,
          reason: 'aborted',
          message: 'scorecard cancelled',
        });
        return;
      }

      const durationMs = Date.now() - startedAt;
      emit({
        type: 'scorecard-completed',
        runId: command.runId,
        readings,
        dimensionsRun,
        costUsd: totalCost,
        durationMs,
        usage: totalUsage,
      });
      this.deps.logger?.info(
        `[scorecard] grading completed — ${readings.length} readings across ${dimensionsRun.length} dimensions, ${fmtCost(totalCost)}, ${fmtElapsed(durationMs)}`,
      );
    } catch (error) {
      this.deps.logger?.warn('scorecard run crashed', error);
      emit({
        type: 'scorecard-failed',
        runId: command.runId,
        reason: run.cancelled ? 'aborted' : 'runner-crash',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.active.delete(command.runId);
    }
  }

  /** Run one dimension pass (with one corrective retry on unparseable output). */
  private async runDimension(
    command: StartScorecard,
    dimension: ScorecardDimension,
    run: ActiveRun,
    inventory: string,
  ): Promise<DimensionOutcome> {
    const preset = scorecardPreset(dimension);
    const usage: TokenUsage = { ...EMPTY_USAGE };
    let costUsd = 0;

    const first = await this.runOneSession(
      command,
      preset,
      buildDimensionPrompt(command, preset, inventory),
      run,
    );
    addUsage(usage, first.usage);
    costUsd += first.costUsd;

    if (run.cancelled) {
      return { usage, costUsd, error: 'cancelled', reason: 'aborted' };
    }
    if (first.result === undefined) {
      return {
        usage,
        costUsd,
        error: first.error ?? 'no result',
        ...(first.reason !== undefined ? { reason: first.reason } : {}),
      };
    }

    let parsed = parseReading(first.result, dimension);
    let reason = first.reason;
    if (parsed.reading === undefined) {
      // One corrective retry: the pass returned prose, not JSON. Re-ask strictly.
      this.deps.logger?.debug('scorecard dimension produced no JSON; retrying', {
        runId: command.runId,
        dimension,
      });
      const retry = await this.runOneSession(
        command,
        preset,
        `${buildDimensionPrompt(command, preset, inventory)}\n\nIMPORTANT: your previous answer was not valid JSON. Respond with ONLY the JSON object, nothing else.`,
        run,
      );
      addUsage(usage, retry.usage);
      costUsd += retry.costUsd;
      if (run.cancelled) reason = 'aborted';
      else if (retry.result !== undefined) {
        parsed = parseReading(retry.result, dimension);
        reason = retry.reason;
      } else if (retry.reason !== undefined) {
        reason = retry.reason;
      }
    }

    return {
      ...(parsed.reading !== undefined ? { reading: parsed.reading } : {}),
      usage,
      costUsd,
      ...(parsed.error !== undefined ? { error: parsed.error } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  /** Spin one read-only SessionRunner and capture its terminal result/usage. The
   *  runner's events are consumed locally and never forwarded to the main stream. */
  private async runOneSession(
    command: StartScorecard,
    preset: ScorecardPreset,
    prompt: string,
    run: ActiveRun,
  ): Promise<{
    result?: string;
    usage: TokenUsage;
    costUsd: number;
    error?: string;
    reason?: SessionFailedReason;
  }> {
    let result: string | undefined;
    let usage: TokenUsage = { ...EMPTY_USAGE };
    let costUsd = 0;
    let error: string | undefined;
    let reason: SessionFailedReason | undefined;
    const heartbeat = makeHeartbeat(
      this.deps.logger,
      `[scorecard:${preset.dimension}]`,
    );

    const runner = this.runnerFactory(
      {
        sessionId: -1,
        prompt,
        model: command.model ?? this.deps.config.model,
        ...(command.effort ?? this.deps.config.effort
          ? { effort: command.effort ?? this.deps.config.effort }
          : {}),
        permissionMode: 'dontAsk',
        permissionPolicy: this.deps.config.permissions,
        cwd: command.projectPath,
        apiKeyFallback: this.deps.apiKeyFallback,
        settingSources: this.deps.config.settingSources,
        todoFeatureEnabled: false,
        appendSystemPrompt: `${ANALYZER_PERSONA} ${preset.rubric}`,
        allowedTools: [...SCORECARD_ALLOWED_TOOLS],
        disallowedTools: [...SCORECARD_DISALLOWED_TOOLS],
        maxTurns: command.maxTurnsPerDimension ?? DEFAULT_MAX_TURNS,
        ...(command.maxBudgetUsdPerDimension !== undefined
          ? { maxBudgetUsd: command.maxBudgetUsdPerDimension }
          : {}),
      },
      (event) => {
        if (event.type === 'session-completed') {
          result = event.result;
          costUsd = event.costUsd;
          if (event.usage !== undefined) usage = event.usage;
        } else if (event.type === 'session-failed') {
          error = event.message;
          reason = event.reason;
        } else {
          heartbeat(event);
        }
      },
      this.deps.logger?.child(`scorecard-${preset.dimension}`),
    );

    run.runners.add(runner);
    try {
      await runner.run();
    } finally {
      run.runners.delete(runner);
    }
    return {
      result,
      usage,
      costUsd,
      ...(error !== undefined ? { error } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
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

/** Accumulate token usage in place. */
function addUsage(into: TokenUsage, add: TokenUsage | undefined): void {
  if (add === undefined) return;
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
  into.cacheReadTokens += add.cacheReadTokens;
  into.cacheCreationTokens += add.cacheCreationTokens;
}
