/**
 * The Insight analysis orchestrator. Fans out one READ-ONLY Claude pass per
 * category (bounded-concurrent — honestly parallel, unlike Aperant's
 * sequential-but-labeled-parallel loop), parses + grounds each pass's findings
 * via the pure helpers, streams `analysis-*` events, then de-dups across
 * categories and emits a final `analysis-completed`. The category sub-sessions
 * are INTERNAL: their ordinary session events are consumed here and never reach
 * the main event stream — only `analysis-*` events do.
 */
import type {
  Config,
  Finding,
  FindingCategory,
  NightcoreEvent,
  SurfaceCommand,
  TokenUsage,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';
import { SessionRunner, type SessionRunnerConfig } from './session-runner.js';
import {
  ANALYSIS_ALLOWED_TOOLS,
  ANALYSIS_DISALLOWED_TOOLS,
  ANALYZER_PERSONA,
  analysisPreset,
  outputContract,
  type AnalysisPreset,
} from './analysis-presets.js';
import {
  dedupeFindings,
  groundFindings,
  parseFindings,
} from './analysis-findings.js';

/** The `start-analysis` command variant (the zod schema is exported as a value,
 *  so the engine narrows the union for the type). */
type StartAnalysis = Extract<SurfaceCommand, { type: 'start-analysis' }>;

/** Default number of category passes to run at once. Bounded so a 9-category run
 *  doesn't open 9 paid Claude subprocesses simultaneously. */
const DEFAULT_CONCURRENCY = 3;
/** Per-category turn ceiling (the model explores then writes findings). */
const DEFAULT_MAX_TURNS = 40;
/** Findings cap per category pass. */
const MAX_FINDINGS_PER_CATEGORY = 8;

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

/** The slice of `SessionRunner` the orchestrator drives: run the loop to a
 *  terminal state, and interrupt it on cancel. A factory returning this lets tests
 *  inject a fake runner without spawning the SDK. */
export interface AnalysisSessionRunner {
  run(): Promise<void>;
  interrupt(): Promise<void>;
}

/** Constructs the runner for one category pass. Defaults to the real
 *  {@link SessionRunner}; overridable in tests. */
export type AnalysisRunnerFactory = (
  config: SessionRunnerConfig,
  emit: (event: NightcoreEvent) => void,
  logger?: Logger,
) => AnalysisSessionRunner;

const defaultRunnerFactory: AnalysisRunnerFactory = (config, emit, logger) =>
  new SessionRunner(config, emit, logger);

export interface AnalysisManagerDeps {
  config: Config;
  apiKeyFallback: boolean;
  emit: (event: NightcoreEvent) => void;
  logger?: Logger;
  /** Override the per-category runner construction (tests inject a fake). Defaults
   *  to the real `SessionRunner` so the production call site needs no change. */
  runnerFactory?: AnalysisRunnerFactory;
}

interface ActiveRun {
  runId: string;
  runners: Set<AnalysisSessionRunner>;
  cancelled: boolean;
}

interface CategoryOutcome {
  findings: Finding[];
  usage: TokenUsage;
  costUsd: number;
  error?: string;
  /** The structured `session-failed` reason from the underlying pass, when one
   *  failed (authentication | rate-limit | aborted | runner-crash | max-turns |
   *  max-budget | unknown). Distinct from `error` (the human-readable message). */
  reason?: SessionFailedReason;
}

export class AnalysisManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly runnerFactory: AnalysisRunnerFactory;

  constructor(private readonly deps: AnalysisManagerDeps) {
    this.runnerFactory = deps.runnerFactory ?? defaultRunnerFactory;
  }

  /** Start a run. Fire-and-forget: failures surface as an `analysis-failed`
   *  event, never a rejected promise (degrade-not-throw, like the SessionManager). */
  start(command: StartAnalysis): void {
    if (this.active.has(command.runId)) {
      this.deps.logger?.debug('analysis run already active; ignoring start', {
        runId: command.runId,
      });
      return;
    }
    void this.runAnalysis(command);
  }

  /** Cancel an in-flight run: abort every live category pass. */
  cancel(runId: string): void {
    const run = this.active.get(runId);
    if (run === undefined) return;
    run.cancelled = true;
    for (const runner of run.runners) {
      void runner.interrupt();
    }
  }

  private async runAnalysis(command: StartAnalysis): Promise<void> {
    const { emit } = this.deps;
    const run: ActiveRun = {
      runId: command.runId,
      runners: new Set(),
      cancelled: false,
    };
    this.active.set(command.runId, run);
    const startedAt = Date.now();

    emit({
      type: 'analysis-started',
      runId: command.runId,
      scope: command.scope,
      categories: command.categories,
      model: command.model ?? this.deps.config.model,
    });

    const all: Finding[] = [];
    const categoriesRun: FindingCategory[] = [];
    let totalCost = 0;
    const totalUsage: TokenUsage = { ...EMPTY_USAGE };

    try {
      await runPool(
        command.categories,
        command.maxConcurrency ?? DEFAULT_CONCURRENCY,
        async (category) => {
          if (run.cancelled) return;
          emit({
            type: 'analysis-category-started',
            runId: command.runId,
            category,
          });

          const outcome = await this.runCategory(command, category, run);
          if (run.cancelled) return;

          const grounded = groundFindings(outcome.findings, command.projectPath);
          categoriesRun.push(category);
          totalCost += outcome.costUsd;
          addUsage(totalUsage, outcome.usage);
          all.push(...grounded);

          emit({
            type: 'analysis-category-completed',
            runId: command.runId,
            category,
            findings: grounded,
            usage: outcome.usage,
            costUsd: outcome.costUsd,
            ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          });
        },
      );

      if (run.cancelled) {
        emit({
          type: 'analysis-failed',
          runId: command.runId,
          reason: 'aborted',
          message: 'analysis cancelled',
        });
        return;
      }

      const deduped = dedupeFindings(all);
      emit({
        type: 'analysis-completed',
        runId: command.runId,
        findings: deduped,
        categoriesRun,
        costUsd: totalCost,
        durationMs: Date.now() - startedAt,
        usage: totalUsage,
      });
    } catch (error) {
      this.deps.logger?.warn('analysis run crashed', error);
      emit({
        type: 'analysis-failed',
        runId: command.runId,
        reason: run.cancelled ? 'aborted' : 'runner-crash',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.active.delete(command.runId);
    }
  }

  /** Run one category pass (with one corrective retry on unparseable output). */
  private async runCategory(
    command: StartAnalysis,
    category: FindingCategory,
    run: ActiveRun,
  ): Promise<CategoryOutcome> {
    const preset = analysisPreset(category);
    const usage: TokenUsage = { ...EMPTY_USAGE };
    let costUsd = 0;

    const first = await this.runOneSession(
      command,
      preset,
      buildCategoryPrompt(command, preset),
      run,
    );
    addUsage(usage, first.usage);
    costUsd += first.costUsd;

    if (run.cancelled) {
      return { findings: [], usage, costUsd, error: 'cancelled', reason: 'aborted' };
    }
    if (first.result === undefined) {
      return {
        findings: [],
        usage,
        costUsd,
        error: first.error ?? 'no result',
        ...(first.reason !== undefined ? { reason: first.reason } : {}),
      };
    }

    let parsed = parseFindings(first.result, category);
    let reason = first.reason;
    if (parsed.error !== undefined) {
      // One corrective retry: the pass returned prose, not JSON. Re-ask with a
      // strict reminder (cheap relative to losing the whole category).
      this.deps.logger?.debug('analysis category produced no JSON; retrying', {
        runId: command.runId,
        category,
      });
      const retry = await this.runOneSession(
        command,
        preset,
        `${buildCategoryPrompt(command, preset)}\n\nIMPORTANT: your previous answer was not valid JSON. Respond with ONLY the JSON array, nothing else.`,
        run,
      );
      addUsage(usage, retry.usage);
      costUsd += retry.costUsd;
      if (run.cancelled) reason = 'aborted';
      else if (retry.result !== undefined) {
        parsed = parseFindings(retry.result, category);
        reason = retry.reason;
      } else if (retry.reason !== undefined) {
        reason = retry.reason;
      }
    }

    return {
      findings: parsed.findings,
      usage,
      costUsd,
      ...(parsed.error !== undefined ? { error: parsed.error } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  /** Spin one read-only SessionRunner and capture its terminal result/usage. The
   *  runner's events are consumed locally and never forwarded to the main stream. */
  private async runOneSession(
    command: StartAnalysis,
    preset: AnalysisPreset,
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
        appendSystemPrompt: `${ANALYZER_PERSONA} For this pass, look for: ${preset.focus}`,
        allowedTools: [...ANALYSIS_ALLOWED_TOOLS],
        disallowedTools: [...ANALYSIS_DISALLOWED_TOOLS],
        maxTurns: command.maxTurnsPerCategory ?? DEFAULT_MAX_TURNS,
        ...(command.maxBudgetUsdPerCategory !== undefined
          ? { maxBudgetUsd: command.maxBudgetUsdPerCategory }
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
        }
      },
      this.deps.logger?.child(`analysis-${preset.category}`),
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

/** The per-run user prompt for a category pass. */
function buildCategoryPrompt(
  command: StartAnalysis,
  preset: AnalysisPreset,
): string {
  const scopeLine =
    command.scope === 'diff' &&
    command.changedFiles !== undefined &&
    command.changedFiles.length > 0
      ? `Focus your analysis ONLY on these recently changed files and the code they directly touch:\n${command.changedFiles
          .map((f) => `- ${f}`)
          .join('\n')}`
      : 'Analyze the whole repository. Explore the structure first (read the entry points and the most-edited areas), then drill into where issues are most likely.';

  return [
    `You are analyzing the project at: ${command.projectPath}`,
    `Category: ${preset.label}.`,
    scopeLine,
    '',
    outputContract(MAX_FINDINGS_PER_CATEGORY),
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

/**
 * Run `worker` over `items` with at most `concurrency` in flight. Resolves when
 * all are done. A worker that throws propagates (the orchestrator wraps the whole
 * pool in try/catch). Order of completion is not guaranteed; effects are emitted
 * as each finishes (streaming UX).
 */
async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const cap = Math.max(1, Math.min(concurrency, items.length || 1));
  let cursor = 0;
  const runNext = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: cap }, () => runNext()));
}
