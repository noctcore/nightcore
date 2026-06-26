/**
 * The Insight analysis orchestrator. Fans out one READ-ONLY Claude pass per
 * category (bounded-concurrent — honestly parallel, unlike Aperant's
 * sequential-but-labeled-parallel loop), parses + grounds each pass's findings
 * via the pure helpers, streams `analysis-*` events, then de-dups across
 * categories and emits a final `analysis-completed`. The category sub-sessions
 * are INTERNAL: their ordinary session events are consumed here and never reach
 * the main event stream — only `analysis-*` events do.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
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

/** Default number of category passes to run at once. Raised from 3→6 (WS4): a
 *  3-wide pool left a 9-category scan running in three slow serial waves; 6 keeps
 *  the wall-clock down while still bounded so we never open all 9 paid Claude
 *  subprocesses at once. `runPool` caps this at `categories.length`, so a small run
 *  is effectively `min(categories.length, 6)`. `command.maxConcurrency` overrides it. */
const DEFAULT_CONCURRENCY = 6;
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

    const model = command.model ?? this.deps.config.model;
    emit({
      type: 'analysis-started',
      runId: command.runId,
      scope: command.scope,
      categories: command.categories,
      model,
    });
    this.deps.logger?.info(
      `[insight] scan started — ${command.categories.length} categories · model ${model} · scope ${command.scope}`,
    );

    const all: Finding[] = [];
    const categoriesRun: FindingCategory[] = [];
    let totalCost = 0;
    const totalUsage: TokenUsage = { ...EMPTY_USAGE };
    // Deterministic top-level map injected into every pass so a lens starts from a
    // known structure instead of re-discovering the tree (WS4).
    const inventory = buildRepoInventory(command.projectPath);

    try {
      await runPool(
        command.categories,
        command.maxConcurrency ?? DEFAULT_CONCURRENCY,
        async (category) => {
          if (run.cancelled) return;
          const categoryStartedAt = Date.now();
          emit({
            type: 'analysis-category-started',
            runId: command.runId,
            category,
          });
          this.deps.logger?.info(`[insight] category ${category}: started`);

          const outcome = await this.runCategory(
            command,
            category,
            run,
            inventory,
          );
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
          this.deps.logger?.info(
            `[insight] category ${category}: completed — ${grounded.length} findings, ${fmtCost(outcome.costUsd)}, ${fmtSecs(Date.now() - categoryStartedAt)}`,
          );
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
      const durationMs = Date.now() - startedAt;
      emit({
        type: 'analysis-completed',
        runId: command.runId,
        findings: deduped,
        categoriesRun,
        costUsd: totalCost,
        durationMs,
        usage: totalUsage,
      });
      this.deps.logger?.info(
        `[insight] scan completed — ${deduped.length} findings across ${categoriesRun.length} categories, ${fmtCost(totalCost)}, ${fmtElapsed(durationMs)}`,
      );
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
    inventory: string,
  ): Promise<CategoryOutcome> {
    const preset = analysisPreset(category);
    const usage: TokenUsage = { ...EMPTY_USAGE };
    let costUsd = 0;

    const first = await this.runOneSession(
      command,
      preset,
      buildCategoryPrompt(command, preset, inventory),
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
        `${buildCategoryPrompt(command, preset, inventory)}\n\nIMPORTANT: your previous answer was not valid JSON. Respond with ONLY the JSON array, nothing else.`,
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
    // Throttled progress so a long pass shows life in the terminal instead of
    // running silent until it completes (the sub-session's events never hit the wire).
    const heartbeat = makeHeartbeat(this.deps.logger, `[insight:${preset.category}]`);

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
        } else {
          heartbeat(event);
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

/** The per-run user prompt for a category pass. The deterministic top-level
 *  `inventory` is injected so the pass targets its reads from a known map instead
 *  of re-listing the tree (WS4 — cuts redundant exploration turns). */
function buildCategoryPrompt(
  command: StartAnalysis,
  preset: AnalysisPreset,
  inventory: string,
): string {
  const scopeLine =
    command.scope === 'diff' &&
    command.changedFiles !== undefined &&
    command.changedFiles.length > 0
      ? `Focus your analysis ONLY on these recently changed files and the code they directly touch:\n${command.changedFiles
          .map((f) => `- ${f}`)
          .join('\n')}`
      : 'Analyze the whole repository. Use the repo map above to target the entry points and the most relevant areas, then drill into where issues are most likely — do not spend turns re-listing the tree.';

  return [
    `You are analyzing the project at: ${command.projectPath}`,
    `Category: ${preset.label}.`,
    '',
    'REPO MAP (deterministic top-level inventory — start here):',
    inventory,
    '',
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

// ── shared scan observability + grounding helpers (reused by the Harness
//    orchestrator, which mirrors this one) ────────────────────────────────────

/** Heartbeat throttle: at most one progress line per sub-session this often. A
 *  16-minute scan used to print two lines then go silent; this surfaces steady
 *  life without flooding the terminal. */
const HEARTBEAT_INTERVAL_MS = 3000;

/**
 * Build a throttled heartbeat sink for an internal sub-session. The lens/synthesis
 * sub-sessions are consumed locally (never forwarded to the wire), so a long pass
 * looks frozen from the terminal. This counts `tool-use-requested` events as
 * "turns" and logs at most once per {@link HEARTBEAT_INTERVAL_MS} via `logger.info`
 * (info shows by default; debug is filtered) e.g. `[insight:perf] turn 12 · Read
 * src/app.ts`. Call the returned sink for EVERY sub-session event — it ignores
 * everything but tool uses. A no-op when there is no logger.
 */
export function makeHeartbeat(
  logger: Logger | undefined,
  label: string,
): (event: NightcoreEvent) => void {
  if (logger === undefined) return () => {};
  let turn = 0;
  let lastBeatAt = 0;
  return (event) => {
    if (event.type !== 'tool-use-requested') return;
    turn += 1;
    const now = Date.now();
    if (now - lastBeatAt < HEARTBEAT_INTERVAL_MS) return;
    lastBeatAt = now;
    logger.info(
      `${label} turn ${turn} · ${summarizeToolUse(event.toolName, event.input)}`,
    );
  };
}

/** A short, secret-free descriptor of a tool use for the heartbeat line — the
 *  tool name plus, ONLY for path-like args, its target path (truncated). We never
 *  surface model-controlled value args (pattern/command/query/prompt) here: they
 *  can carry secrets/PII and would leak to the persistent terminal + rolling log. */
function summarizeToolUse(toolName: string, input: unknown): string {
  const rec =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const pick = (key: string): string | undefined =>
    typeof rec[key] === 'string' ? (rec[key] as string) : undefined;
  const detail = pick('file_path') ?? pick('path') ?? pick('notebook_path');
  if (detail === undefined) return toolName;
  const trimmed = detail.replace(/\s+/g, ' ').trim();
  const short = trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
  return `${toolName} ${short}`;
}

/** Conventional source dirs worth a shallow peek in the repo inventory. */
const INVENTORY_PEEK_DIRS = [
  'src',
  'app',
  'apps',
  'packages',
  'lib',
  'crates',
  'server',
];
/** Cap per listing so a pathological dir can't flood the prompt. */
const INVENTORY_MAX_ENTRIES = 60;
/** Dirs never worth listing (build output / vendored deps / vcs). */
const INVENTORY_SKIP_DIRS = new Set(['node_modules', 'target', 'dist', '.git']);

/**
 * A cheap, bounded top-level map of the repo: the root dir/file names plus a
 * shallow peek into a few conventional source dirs. Injected into each pass's
 * prompt (WS4) so the model starts from a known structure instead of burning turns
 * re-discovering the tree on every lens — the dominant source of wasted exploration
 * in a multi-lens scan. Pure synchronous fs; never throws.
 */
export function buildRepoInventory(projectPath: string): string {
  const root = path.resolve(projectPath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return '(repo inventory unavailable)';
  }
  const skip = (name: string): boolean =>
    name.startsWith('.') || INVENTORY_SKIP_DIRS.has(name);
  const dirs = entries
    .filter((e) => e.isDirectory() && !skip(e.name))
    .map((e) => e.name)
    .sort()
    .slice(0, INVENTORY_MAX_ENTRIES);
  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
    .slice(0, INVENTORY_MAX_ENTRIES);
  const lines = [
    `top-level dirs: ${dirs.join(', ') || '(none)'}`,
    `top-level files: ${files.join(', ') || '(none)'}`,
  ];
  for (const dir of INVENTORY_PEEK_DIRS) {
    if (!dirs.includes(dir)) continue;
    try {
      const children = fs
        .readdirSync(path.join(root, dir), { withFileTypes: true })
        .filter((e) => !skip(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .slice(0, INVENTORY_MAX_ENTRIES);
      if (children.length > 0) lines.push(`${dir}/: ${children.join(', ')}`);
    } catch {
      /* unreadable dir — skip it, never throw */
    }
  }
  return lines.join('\n');
}

/** `$1.20`-style cost for a log line. */
export function fmtCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** `41.2s`-style short duration for a per-pass log line. */
export function fmtSecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** `6:12`-style elapsed for a whole-scan log line. */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
