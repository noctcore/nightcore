/**
 * The shared data-shape contracts + tuning constants for {@link ScanManager}
 * (extracted from `./scan-manager.js` so the orchestrator file stays under its size
 * ratchet). These are the identical-across-features shapes the generic orchestrator
 * reads directly — deps, the base `start-*` command, the active-run record, the
 * per-pass / per-item outcomes, the per-item session config, and the args bags handed
 * to the `emitItemCompleted` / `finalize` hooks — plus the pool / turn / retry
 * defaults. Pure declarations: no behavior lives here. Re-exported from
 * `./scan-manager.js` so every existing `../shared/scan-manager.js` importer is
 * unchanged.
 */
import type {
  Config,
  DeepScanConfig,
  EffortLevel,
  NightcoreEvent,
  TokenUsage,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import type { SessionRunnerConfig } from '../../providers/claude/session-runner.js';
import type { ProviderRegistry } from '../../providers/provider-factory.js';
import type { ScanRunnerFactory, ScanSessionRunner } from './runner-factory.js';

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
