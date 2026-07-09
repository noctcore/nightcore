/**
 * The generic "scan" orchestrator shared by the three run-based analysis features
 * (Insight, Readiness Scorecard, Harness).
 *
 * Every scan follows the SAME shape: emit a `*-started`, optionally derive some
 * deterministic pre-fanout context, fan out one READ-ONLY Claude pass per item
 * (category / dimension / lens) bounded-concurrent, parse+ground each pass with one
 * corrective retry, stream `*-item` progress events, accumulate usage/cost, then
 * finalize (dedup? synthesize? emit `*-completed`). Cancellation aborts every live
 * pass and surfaces a `*-failed` with reason `aborted`; any crash degrades to a
 * `*-failed` with reason `runner-crash` — never a rejected promise.
 *
 * [`ScanManager`] owns that whole mechanism ONCE — the active-run registry, the
 * bounded pool, the per-item retry, the single `runOneSession` runner spin, the
 * usage accumulation, and the cancel/crash handling. Each feature subclass injects
 * ONLY what genuinely diverges through the abstract hooks below: which items to run,
 * the per-item preset + session config + prompt, the parse/ground helpers, and the
 * feature-shaped `*-started` / `*-item` / `*-completed` / `*-failed` events (whose
 * `type` strings and payload field names differ per feature). This replaces three
 * structurally-identical manager classes so a cross-cutting fix (a pool bug, a retry
 * change, a new cancel guard) lands in one audited place instead of three clones.
 */
import type {
  Config,
  EffortLevel,
  NightcoreEvent,
  TokenUsage,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import {
  SessionRunner,
  type SessionRunnerConfig,
} from '../../providers/claude/session-runner.js';
import { buildRepoInventory } from './inventory.js';
import { makeHeartbeat } from './observability.js';
import { runPool } from './pool.js';

/** Default number of passes to run at once. A 6-wide pool keeps the wall-clock down
 *  while staying bounded so we never open all items' paid Claude subprocesses at
 *  once. `runPool` caps this at `items.length`; `command.maxConcurrency` overrides it. */
export const DEFAULT_CONCURRENCY = 6;
/** Per-pass turn ceiling (the model explores then writes its output). */
export const DEFAULT_MAX_TURNS = 40;

/** A zeroed usage total; copy it (`{ ...EMPTY_USAGE }`) before accumulating. */
export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningOutputTokens: 0,
};

/** The strict-JSON reminder appended to the ONE corrective retry of an ARRAY-shaped
 *  pass (Insight / Harness / PR-review). Shared so the wording can't drift per
 *  feature; the retry mechanism itself lives in the base `runItem`. */
export const RETRY_REMINDER_ARRAY =
  '\n\nIMPORTANT: your previous answer was not valid JSON. Respond with ONLY the JSON array, nothing else.';

/** The strict-JSON reminder for an OBJECT-shaped pass (Scorecard / Issue-triage). */
export const RETRY_REMINDER_OBJECT =
  '\n\nIMPORTANT: your previous answer was not valid JSON. Respond with ONLY the JSON object, nothing else.';

/** The stable failure reason carried by a `session-failed` event. */
export type SessionFailedReason = Extract<
  NightcoreEvent,
  { type: 'session-failed' }
>['reason'];

/** The reason a whole scan surfaces on its `*-failed` event. The base only ever
 *  reports a cancel (`aborted`) or an uncaught crash (`runner-crash`); the wider
 *  per-session reasons are collapsed into the crash message. A subset of every
 *  feature's `*-failed` reason union, so it is assignable to all three. */
export type ScanFailureReason = 'aborted' | 'runner-crash';

/** The slice of `SessionRunner` the orchestrator drives: run the loop to a terminal
 *  state, and interrupt it on cancel. A factory returning this lets tests inject a
 *  fake runner without spawning the SDK. */
export interface ScanSessionRunner {
  run(): Promise<void>;
  interrupt(): Promise<void>;
}

/** Constructs the runner for one pass. Defaults to the real {@link SessionRunner};
 *  overridable in tests. */
export type ScanRunnerFactory = (
  config: SessionRunnerConfig,
  emit: (event: NightcoreEvent) => void,
  logger?: Logger,
) => ScanSessionRunner;

export const defaultRunnerFactory: ScanRunnerFactory = (config, emit, logger) =>
  new SessionRunner(config, emit, logger);

/** The dependencies every scan manager takes — identical across all three features. */
export interface ScanManagerDeps {
  config: Config;
  apiKeyFallback: boolean;
  emit: (event: NightcoreEvent) => void;
  logger?: Logger;
  /** Override the per-pass runner construction (tests inject a fake). Defaults to
   *  the real `SessionRunner` so the production call site needs no change. */
  runnerFactory?: ScanRunnerFactory;
}

/** The minimal shape every `start-*` scan command shares — the fields the generic
 *  orchestrator reads directly. Each feature's concrete command is a superset. */
export interface BaseScanCommand {
  runId: string;
  projectPath: string;
  model?: string;
  effort?: EffortLevel;
  maxConcurrency?: number;
}

/** One in-flight scan: its live runner set (so cancel can interrupt them) and a
 *  cancellation flag the pool + finalize check. */
export interface ActiveScanRun {
  runId: string;
  runners: Set<ScanSessionRunner>;
  cancelled: boolean;
}

/** The terminal result of one `runOneSession` spin. */
export interface SessionOutcome {
  result?: string;
  usage: TokenUsage;
  costUsd: number;
  error?: string;
  reason?: SessionFailedReason;
}

/** The result of one item pass (after the corrective-retry logic). `findings` is the
 *  normalized 0-or-more parsed items — Insight/Harness yield many, Scorecard yields a
 *  single reading wrapped as a 0-or-1 element list. */
export interface ItemOutcome<TFinding> {
  findings: TFinding[];
  usage: TokenUsage;
  costUsd: number;
  error?: string;
  reason?: SessionFailedReason;
}

/** The per-item session config the base assembles into the full runner config: the
 *  ONLY parts that differ per feature (persona + read-only toolset + turn/budget
 *  ceilings). The common fields (model, effort, permission mode/policy, cwd, api key
 *  fallback, setting sources, todo off) are filled by {@link ScanManager.runOneSession}. */
export interface SessionConfigParts {
  appendSystemPrompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  maxTurns: number;
  maxBudgetUsd?: number;
}

/** Args handed to {@link ScanManager.emitItemCompleted} — a bag so subclasses read
 *  only what their event needs without a long positional signature. */
export interface ItemCompletedArgs<TCommand, TItem, TFinding> {
  command: TCommand;
  item: TItem;
  /** The grounded parsed items from this pass (0-or-more). */
  grounded: TFinding[];
  outcome: ItemOutcome<TFinding>;
  /** Wall-clock for this pass, for the per-item log line. */
  elapsedMs: number;
}

/** Args handed to {@link ScanManager.finalize} — everything the tail needs to dedup,
 *  synthesize, and emit the feature's `*-completed`. */
export interface FinalizeArgs<TCommand, TItem, TFinding, TContext> {
  command: TCommand;
  run: ActiveScanRun;
  /** Every grounded item across all passes (pre-dedup — the subclass dedups if it wants). */
  findings: TFinding[];
  /** The items that actually ran (for the `categoriesRun`/`dimensionsRun` field). */
  itemsRun: TItem[];
  totalCost: number;
  totalUsage: TokenUsage;
  /** Scan start timestamp — finalize computes its own `durationMs` (`Date.now() -
   *  startedAt`) so a feature whose tail does more work (Harness's synthesis pass)
   *  measures the full wall-clock, not just up to the last item. */
  startedAt: number;
  /** The pre-fanout context from {@link ScanManager.prepare} (Harness's repo profile;
   *  `{}` for the others). */
  context: TContext;
  /** The deterministic top-level repo map built once for the passes — threaded so a
   *  tail that spins another session (Harness's synthesis) reuses it instead of
   *  re-walking the filesystem. */
  inventory: string;
}

/**
 * The generic scan orchestrator. `TCommand` is the concrete `start-*` command,
 * `TItem` the per-pass unit (category/dimension/lens), `TPreset` its resolved preset
 * (only `label` is read generically), `TFinding` the grounded output item, and
 * `TContext` the pre-fanout context (`{}` unless a feature derives one).
 */
export abstract class ScanManager<
  TCommand extends BaseScanCommand,
  TItem,
  TPreset extends { label: string },
  TFinding,
  TContext = Record<string, never>,
> {
  protected readonly active = new Map<string, ActiveScanRun>();
  protected readonly runnerFactory: ScanRunnerFactory;

  constructor(protected readonly deps: ScanManagerDeps) {
    this.runnerFactory = deps.runnerFactory ?? defaultRunnerFactory;
  }

  /** Start a run. Fire-and-forget: failures surface as a `*-failed` event, never a
   *  rejected promise (degrade-not-throw, like the SessionManager). A duplicate
   *  `runId` while the first is still active is ignored. */
  start(command: TCommand): void {
    if (this.active.has(command.runId)) {
      this.deps.logger?.debug('scan run already active; ignoring start', {
        runId: command.runId,
      });
      return;
    }
    void this.execute(command);
  }

  /** Cancel an in-flight run: abort every live pass (and any synthesis tail). */
  cancel(runId: string): void {
    const run = this.active.get(runId);
    if (run === undefined) return;
    run.cancelled = true;
    for (const runner of run.runners) {
      void runner.interrupt();
    }
  }

  /** The shared orchestration skeleton: started → prepare → fan-out(+ground+accumulate)
   *  → (cancel-check) → finalize, all wrapped in degrade-not-throw. */
  private async execute(command: TCommand): Promise<void> {
    const run: ActiveScanRun = {
      runId: command.runId,
      runners: new Set(),
      cancelled: false,
    };
    this.active.set(command.runId, run);
    const startedAt = Date.now();

    const model = command.model ?? this.deps.config.model;
    this.emitStarted(command, model);

    const all: TFinding[] = [];
    const itemsRun: TItem[] = [];
    let totalCost = 0;
    const totalUsage: TokenUsage = { ...EMPTY_USAGE };

    try {
      // Feature-specific pre-fanout work (Harness detects + emits its repo profile).
      const context = await this.prepare(command, run);
      // Deterministic top-level map injected into every pass so a pass starts from a
      // known structure instead of re-discovering the tree.
      const inventory = buildRepoInventory(command.projectPath);

      await runPool(
        this.items(command),
        command.maxConcurrency ?? DEFAULT_CONCURRENCY,
        async (item) => {
          if (run.cancelled) return;
          const itemStartedAt = Date.now();
          this.emitItemStarted(command, item);

          const outcome = await this.runItem(
            command,
            item,
            run,
            context,
            inventory,
          );
          if (run.cancelled) return;

          // A per-item session that FAILED (or produced unparseable output after the
          // corrective retry) still flows through `emitItemCompleted` below as a
          // *completed* item with 0 findings — so without this an all-failed scan
          // reads as a benign empty result in the logs (every category "completed —
          // 0 findings, $0.00"), and the captured reason/message is otherwise logged
          // nowhere. Surface it so an unexpectedly $0 / 0-finding pass is diagnosable
          // (e.g. an API rate-limit that rejected each session before any billable
          // work — the failure the UI already renders but the terminal hid).
          if (outcome.reason !== undefined || outcome.error !== undefined) {
            this.deps.logger?.warn('scan item session did not complete cleanly', {
              runId: command.runId,
              item: typeof item === 'string' ? item : JSON.stringify(item),
              ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
              ...(outcome.error !== undefined ? { message: outcome.error } : {}),
            });
          }

          const grounded = this.ground(outcome.findings, command.projectPath);
          itemsRun.push(item);
          totalCost += outcome.costUsd;
          addUsage(totalUsage, outcome.usage);
          all.push(...grounded);

          this.emitItemCompleted({
            command,
            item,
            grounded,
            outcome,
            elapsedMs: Date.now() - itemStartedAt,
          });
        },
      );

      if (run.cancelled) {
        this.emitFailed(command, 'aborted', this.cancelledMessage());
        return;
      }

      await this.finalize({
        command,
        run,
        findings: all,
        itemsRun,
        totalCost,
        totalUsage,
        startedAt,
        context,
        inventory,
      });
    } catch (error) {
      this.deps.logger?.warn('scan run crashed', error);
      this.emitFailed(
        command,
        run.cancelled ? 'aborted' : 'runner-crash',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.active.delete(command.runId);
    }
  }

  /** Run one item pass with exactly one corrective retry on unparseable output. The
   *  retry re-asks with the feature's strict JSON reminder (cheap relative to losing
   *  the whole pass). Identical across all three features modulo the injected
   *  parse + prompt + reminder. */
  private async runItem(
    command: TCommand,
    item: TItem,
    run: ActiveScanRun,
    context: TContext,
    inventory: string,
  ): Promise<ItemOutcome<TFinding>> {
    const preset = this.preset(item);
    const usage: TokenUsage = { ...EMPTY_USAGE };
    let costUsd = 0;

    const prompt = this.buildPrompt(command, preset, context, inventory);
    const first = await this.runOneSession(command, preset, prompt, run);
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

    let parsed = this.parse(first.result, item);
    let reason = first.reason;
    if (parsed.error !== undefined) {
      this.deps.logger?.debug('scan pass produced no JSON; retrying', {
        runId: command.runId,
      });
      const retry = await this.runOneSession(
        command,
        preset,
        `${prompt}${this.retryReminderSuffix()}`,
        run,
      );
      addUsage(usage, retry.usage);
      costUsd += retry.costUsd;
      if (run.cancelled) reason = 'aborted';
      else if (retry.result !== undefined) {
        parsed = this.parse(retry.result, item);
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
   *  runner's events are consumed locally and never forwarded to the main stream —
   *  only the feature's `*-*` events do. Identical across features; the persona +
   *  toolset + ceilings come from {@link sessionConfig}. */
  protected async runOneSession(
    command: TCommand,
    preset: TPreset,
    prompt: string,
    run: ActiveScanRun,
  ): Promise<SessionOutcome> {
    let result: string | undefined;
    let usage: TokenUsage = { ...EMPTY_USAGE };
    let costUsd = 0;
    let error: string | undefined;
    let reason: SessionFailedReason | undefined;
    // Throttled progress so a long pass shows life in the terminal instead of
    // running silent until it completes (the sub-session's events never hit the wire).
    const heartbeat = makeHeartbeat(this.deps.logger, this.heartbeatLabel(preset));

    const parts = this.sessionConfig(command, preset);
    const effort = command.effort ?? this.deps.config.effort;
    const runner = this.runnerFactory(
      {
        sessionId: -1,
        prompt,
        model: command.model ?? this.deps.config.model,
        ...(effort ? { effort } : {}),
        permissionMode: 'dontAsk',
        permissionPolicy: this.deps.config.permissions,
        cwd: command.projectPath,
        apiKeyFallback: this.deps.apiKeyFallback,
        settingSources: this.deps.config.settingSources,
        todoFeatureEnabled: false,
        appendSystemPrompt: parts.appendSystemPrompt,
        allowedTools: parts.allowedTools,
        disallowedTools: parts.disallowedTools,
        maxTurns: parts.maxTurns,
        ...(parts.maxBudgetUsd !== undefined
          ? { maxBudgetUsd: parts.maxBudgetUsd }
          : {}),
      },
      (event) => {
        if (event.type === 'session-completed') {
          result = event.result;
          costUsd = event.costUsd ?? 0;
          if (event.usage !== undefined) usage = event.usage;
        } else if (event.type === 'session-failed') {
          error = event.message;
          reason = event.reason;
        } else {
          heartbeat(event);
        }
      },
      this.deps.logger?.child(this.heartbeatLabel(preset)),
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

  // ── Feature hooks: the ONLY parts each scan injects ─────────────────────────

  /** The items (categories / dimensions / lenses) this run fans out over. */
  protected abstract items(command: TCommand): readonly TItem[];

  /** The resolved preset for one item (its `label` + feature-specific fields). */
  protected abstract preset(item: TItem): TPreset;

  /** The per-item persona + read-only toolset + turn/budget ceilings. */
  protected abstract sessionConfig(
    command: TCommand,
    preset: TPreset,
  ): SessionConfigParts;

  /** The heartbeat/log label for one pass, e.g. `[insight:perf]`. */
  protected abstract heartbeatLabel(preset: TPreset): string;

  /** The per-run user prompt for one pass. */
  protected abstract buildPrompt(
    command: TCommand,
    preset: TPreset,
    context: TContext,
    inventory: string,
  ): string;

  /** Parse one pass's raw output into 0-or-more items. `error` is set (triggering the
   *  single corrective retry) exactly when the output could not be parsed. */
  protected abstract parse(
    result: string,
    item: TItem,
  ): { findings: TFinding[]; error?: string };

  /** Ground the parsed items against the real tree (drop/clamp hallucinated refs). */
  protected abstract ground(findings: TFinding[], projectPath: string): TFinding[];

  /** The strict-JSON reminder appended to the ONE corrective retry prompt (differs by
   *  whether the pass returns a JSON array or a single object). */
  protected abstract retryReminderSuffix(): string;

  /** Pre-fanout work: derive + emit any deterministic context (Harness's repo
   *  profile). Default: no context. `command`/`run` are unused here but declared so an
   *  override (Harness) receives them. */
  protected async prepare(
    command: TCommand,
    run: ActiveScanRun,
  ): Promise<TContext> {
    void command;
    void run;
    return {} as TContext;
  }

  /** Emit the feature's `*-started` event (+ its start log line). */
  protected abstract emitStarted(command: TCommand, model: string): void;

  /** Emit the feature's `*-item-started` event (+ its per-item log line). */
  protected abstract emitItemStarted(command: TCommand, item: TItem): void;

  /** Emit the feature's `*-item-completed` event (+ its per-item log line). */
  protected abstract emitItemCompleted(
    args: ItemCompletedArgs<TCommand, TItem, TFinding>,
  ): void;

  /** The tail: dedup? synthesize? then emit the feature's `*-completed` (+ log). May
   *  itself emit a `*-failed` if a late cancel (e.g. mid-synthesis) is detected. */
  protected abstract finalize(
    args: FinalizeArgs<TCommand, TItem, TFinding, TContext>,
  ): Promise<void>;

  /** Emit the feature's `*-failed` event with `reason` + `message`. */
  protected abstract emitFailed(
    command: TCommand,
    reason: ScanFailureReason,
    message: string,
  ): void;

  /** The message a cancel surfaces on the `*-failed` event, e.g. `analysis cancelled`. */
  protected abstract cancelledMessage(): string;

  /** The default concurrency an item pool runs at when the command sets no override.
   *  Exposed so a subclass with a different budget can lower it. */
  protected get defaultConcurrency(): number {
    return DEFAULT_CONCURRENCY;
  }
}

// ── Token-usage accumulation — the one piece of shared scan mechanics that stays
//    with the base class. The bounded pool, heartbeat observability, repo inventory,
//    and log formatters now live in ./pool, ./observability, ./inventory, ./format.
//    Used by the base above and by the synthesis pass. ─────────────────────────────

/** Accumulate token usage in place. */
export function addUsage(into: TokenUsage, add: TokenUsage | undefined): void {
  if (add === undefined) return;
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
  into.cacheReadTokens += add.cacheReadTokens;
  into.cacheCreationTokens += add.cacheCreationTokens;
}
