/**
 * The generic "scan" orchestrator shared by the three run-based analysis features
 * (Insight, Readiness Scorecard, Harness).
 *
 * Every scan follows the SAME shape: emit a `*-started`, optionally derive some
 * deterministic pre-fanout context, fan out one READ-ONLY pass per item
 * (category / dimension / lens) using the selected provider (Claude or Codex etc),
 * bounded-concurrent, parse+ground each pass with one corrective retry, stream
 * `*-item` progress events, accumulate usage/cost, then finalize (dedup? synthesize?
 * emit `*-completed`). Cancellation aborts every live pass and surfaces a `*-failed`
 * with reason `aborted`; any crash degrades to a `*-failed` with reason `runner-crash`
 * — never a rejected promise.
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
  DeepScanConfig,
  EffortLevel,
  NightcoreEvent,
  TokenUsage,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import {
  SessionRunner,
  type SessionRunnerConfig,
} from '../../providers/claude/session-runner.js';
import type { ProviderRegistry } from '../../providers/provider-factory.js';
import { buildRepoInventory } from './inventory.js';
import { runPool } from './pool.js';
import { type RoundCompletedInfo, runRoundLoop } from './round-loop.js';
import { runScanSession } from './session-spin.js';
import { runCorrectivePass } from './single-pass.js';

// Re-exported so feature managers (Insight) override `emitRoundCompleted` in this
// module's vocabulary, mirroring the `ScanRunnerFactory` re-export pattern.
export type { RoundCompletedInfo } from './round-loop.js';
// `addUsage`/`EMPTY_USAGE` live in `./usage.js` so the round loop shares them without a
// cycle; re-exported so this module's public surface is unchanged.
import { addUsage, EMPTY_USAGE } from './usage.js';

export { addUsage, EMPTY_USAGE } from './usage.js';

/** Default number of passes to run at once. A 6-wide pool keeps the wall-clock down
 *  while staying bounded so we never open all items' paid Claude subprocesses at
 *  once. `runPool` caps this at `items.length`; `command.maxConcurrency` overrides it. */
export const DEFAULT_CONCURRENCY = 6;
/** Per-pass turn ceiling (the model explores then writes its output). */
export const DEFAULT_MAX_TURNS = 40;

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

/** Constructs the runner for one pass. For Claude (and tests) this is typically the
 *  real {@link SessionRunner}; for Codex and future providers the manager routes
 *  via the ProviderRegistry instead. Overridable in tests. */
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
  /** Provider registry (claude / codex etc). Used to create the correct read-only
   *  session runner instead of always hardcoding the Claude one. */
  providers?: ProviderRegistry;
  /** Override the per-pass runner construction (tests inject a fake). Defaults to
   *  the real `SessionRunner` so the production call site needs no change. */
  runnerFactory?: ScanRunnerFactory;
}

/** The minimal shape every `start-*` scan command shares — the fields the generic
 *  orchestrator reads directly. Each feature's concrete command is a superset. */
export interface BaseScanCommand {
  runId: string;
  projectPath: string;
  providerId?: string;
  model?: string;
  effort?: EffortLevel;
  maxConcurrency?: number;
  /** Opt-in DEEP mode (issue #294): when set, each item runs as a multi-round
   *  convergence loop instead of a single pass. Absent ⇒ the classic single-pass
   *  path (byte-identical to pre-deep). Only a deep-enabled command populates it. */
  deep?: DeepScanConfig;
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
  /** The SDK's native `structured_output`, when the pass ran under an `outputFormat`.
   *  Threaded to {@link ScanManager.parse}; `undefined` for a free-form pass. */
  structuredOutput?: Record<string, unknown>;
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
  /** SDK-native structured output request (`Options.outputFormat`). When set, the SDK
   *  forces a schema-conforming object onto the `session-completed` event's
   *  `structuredOutput`, which {@link ScanManager.parse} prefers over text parsing. Only
   *  the Claude path wires it (Codex ignores it → text parse). Absent ⇒ free-form text. */
  outputFormat?: SessionRunnerConfig['outputFormat'];
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

          // Deep mode already streamed each round's cumulative findings + per-round
          // spend via `emitRoundCompleted`; a terminal per-item event would
          // double-count that spend in the running store, so the round events are the
          // sole per-item persistence carriers there. Classic path unchanged.
          if (command.deep === undefined) {
            this.emitItemCompleted({
              command,
              item,
              grounded,
              outcome,
              elapsedMs: Date.now() - itemStartedAt,
            });
          }
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

  /** Run one item: the classic single pass (+ one corrective retry), or — when the
   *  command opts into `deep` — the multi-round convergence loop. The non-deep path is
   *  BYTE-IDENTICAL to pre-deep: exactly one pass, same events, same persistence; deep
   *  mode's per-round mechanics all live in {@link runRoundLoop}. */
  private async runItem(
    command: TCommand,
    item: TItem,
    run: ActiveScanRun,
    context: TContext,
    inventory: string,
  ): Promise<ItemOutcome<TFinding>> {
    const preset = this.preset(item);
    const { deep } = command;
    if (deep !== undefined) {
      return runRoundLoop<TFinding>({
        deep,
        buildPrompt: (round, foundSoFar) =>
          this.buildRoundPrompt(command, preset, context, inventory, round, foundSoFar),
        runPass: (prompt) => this.runPass(command, item, run, preset, prompt),
        ground: (findings) => this.deepGround(command, context, findings),
        fingerprint: (finding) => this.deepFingerprint(finding),
        emitRoundCompleted: (info) => this.emitRoundCompleted(command, item, info),
        isCancelled: () => run.cancelled,
      });
    }
    return this.runPass(
      command,
      item,
      run,
      preset,
      this.buildPrompt(command, preset, context, inventory),
    );
  }

  /** Run ONE pass with exactly one corrective retry on unparseable output — a thin
   *  wrapper over {@link runCorrectivePass} that closes over this pass's command /
   *  preset / item / run. BOTH the classic path and every deep round call it with
   *  their prompt; the retry/cancel/accumulate mechanics stay in one audited place. */
  private runPass(
    command: TCommand,
    item: TItem,
    run: ActiveScanRun,
    preset: TPreset,
    prompt: string,
  ): Promise<ItemOutcome<TFinding>> {
    return runCorrectivePass<TFinding>(
      {
        runId: command.runId,
        isCancelled: () => run.cancelled,
        runSession: (p) => this.runOneSession(command, preset, p, run),
        parse: (result, structuredOutput) =>
          this.parse(result, item, structuredOutput),
        reminderSuffix: this.retryReminderSuffix(),
        logger: this.deps.logger,
      },
      prompt,
    );
  }

  /** Spin one read-only session for `prompt` and capture its terminal result/usage —
   *  a thin wrapper resolving the feature's per-pass config + heartbeat label, then
   *  delegating the Claude/Codex construction fork to {@link runScanSession}. The
   *  runner's events are consumed locally; only the feature's `*-*` events reach the
   *  main stream. */
  protected runOneSession(
    command: TCommand,
    preset: TPreset,
    prompt: string,
    run: ActiveScanRun,
  ): Promise<SessionOutcome> {
    return runScanSession(
      this.deps,
      command,
      prompt,
      run,
      this.sessionConfig(command, preset),
      this.heartbeatLabel(preset),
    );
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
   *  single corrective retry) exactly when the output could not be parsed. When the pass
   *  ran under an `outputFormat`, `structuredOutput` carries the SDK's validated object;
   *  the arg is optional, so a text-only feature implements `parse(result, item)`. */
  protected abstract parse(
    result: string,
    item: TItem,
    structuredOutput?: Record<string, unknown>,
  ): { findings: TFinding[]; error?: string };

  /** Ground the parsed items against the real tree (drop/clamp hallucinated refs). */
  protected abstract ground(findings: TFinding[], projectPath: string): TFinding[];

  // ── Deep-mode hooks (issue #294) — reached ONLY when a command sets `deep`, so a
  //    non-deep feature never overrides them and its behavior is unchanged. ─────────

  /** Deep mode: build round `round` (1-based)'s prompt; `foundSoFar` (empty on round 1)
   *  seeds the exclusion list. Default: the round-agnostic single-pass prompt. */
  protected buildRoundPrompt(
    command: TCommand,
    preset: TPreset,
    context: TContext,
    inventory: string,
    round: number,
    foundSoFar: readonly TFinding[],
  ): string {
    void round;
    void foundSoFar;
    return this.buildPrompt(command, preset, context, inventory);
  }

  /** Deep mode: emit the feature's per-round event. Default: no-op. */
  protected emitRoundCompleted(
    command: TCommand,
    item: TItem,
    info: RoundCompletedInfo<TFinding>,
  ): void {
    void command;
    void item;
    void info;
  }

  /** Deep mode: the stable dedup key for a grounded finding (net-new is counted on it,
   *  aligned with the finalize dedup key). Default: structural JSON equality; Insight
   *  overrides to the finding's own fingerprint. */
  protected deepFingerprint(finding: TFinding): string {
    return JSON.stringify(finding);
  }

  /** Deep mode: ground ONE round's raw pass output so the loop's net-new count and the
   *  round event's cumulative set are BOTH grounded (the round-cumulative invariant).
   *  Default: the same `ground(findings, projectPath)` hook the classic path uses — so
   *  Insight/Harness behavior is unchanged. PR-review overrides it: its diff-relative
   *  grounding needs the run's changed-file set, which the base `ground` hook only
   *  threads `projectPath` for (built for disk-grounding features) — the deep `context`
   *  carries it there. Reached ONLY on the deep path. */
  protected deepGround(
    command: TCommand,
    context: TContext,
    findings: TFinding[],
  ): TFinding[] {
    void context;
    return this.ground(findings, command.projectPath);
  }

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
