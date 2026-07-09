/**
 * The shared "tail session" runner — ONE read-only Claude session appended after a
 * scan's fan-out passes (the Harness synthesis, the PR-review adversarial validator,
 * the PR-review merge-verdict synthesis). All three previously hand-rolled the same
 * scaffold: spin a runner via the injectable factory, throttle heartbeat progress,
 * probe cancellation, capture the terminal result, parse it, and re-ask ONCE with a
 * strict-JSON reminder on an unparseable answer. This module owns that mechanism
 * ONCE — one audited retry/cancel path instead of three clones — while each caller
 * keeps only what genuinely differs: its prompt builder, persona, toolset, and parse
 * function.
 *
 * NEVER throws: a THROWN runner (as opposed to a clean `session-failed`) is caught
 * and surfaced as `{ crashed, crashError, error }` with the usage/cost accumulated
 * before the crash, so each caller applies its own crash POLICY — the PR-review
 * validator/verdict FAIL OPEN (log + degrade, documented at their module heads),
 * while the Harness synthesis re-throws into the scan-level `runner-crash` path.
 */
import type { Config, TokenUsage } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { makeHeartbeat } from './observability.js';
import {
  addUsage,
  type BaseScanCommand,
  DEFAULT_MAX_TURNS,
  EMPTY_USAGE,
  type ScanRunnerFactory,
  type ScanSessionRunner,
  type SessionFailedReason,
} from './scan-manager.js';

/** The outcome of one tail-session parse. Setting `error` drives the single
 *  corrective retry; a parse may return BOTH a (degraded) `value` and an `error`
 *  (the Harness synthesis does — empty artifacts plus the parse error). A parse
 *  that returns NO `value` must set `error`, so a fail-open caller always has a
 *  message to log. */
export interface TailParseOutcome<T> {
  value?: T;
  error?: string;
}

export interface TailSessionArgs<T> {
  /** The full pass prompt; the corrective retry re-sends it with
   *  {@link retryReminder} appended. */
  prompt: string;
  /** The appended system prompt (the pass persona). */
  persona: string;
  /** The read-only toolset the pass runs under. */
  tools: { allowed: readonly string[]; disallowed: readonly string[] };
  command: BaseScanCommand;
  config: Config;
  apiKeyFallback: boolean;
  logger?: Logger;
  /** Constructs the runner (the orchestrator passes its resolved factory; tests
   *  inject a fake). */
  runnerFactory: ScanRunnerFactory;
  /** Live-runner registry the orchestrator shares so `cancel()` interrupts the tail
   *  session too. Absent in isolated tests. */
  runners?: Set<ScanSessionRunner>;
  /** Returns true once the run was cancelled (skip work, surface `'cancelled'`). */
  isCancelled?: () => boolean;
  /** `feature:pass` label (e.g. `pr-review:validator`) driving the heartbeat tag
   *  (`[label]`), the child-logger name (`:` → `-`), and the session-failure reason
   *  prefix (the segment after the `:`). */
  label: string;
  /** The strict-JSON reminder appended to the ONE corrective retry. */
  retryReminder: string;
  /** Parse a terminal session result. When the retry session itself fails (no
   *  result), the FIRST parse outcome is kept — degrade, never replace. */
  parse: (result: string) => TailParseOutcome<T>;
  /** Per-pass turn ceiling. Defaults to {@link DEFAULT_MAX_TURNS}. */
  maxTurns?: number;
  /** Optional per-pass budget ceiling forwarded to the runner. */
  maxBudgetUsd?: number;
}

export interface TailSessionResult<T> {
  /** The parsed value, when the pass produced one (possibly degraded — see
   *  {@link TailParseOutcome}). Absent on session failure / unparseable-after-retry /
   *  cancel / crash. */
  value?: T;
  usage: TokenUsage;
  costUsd: number;
  /** Set on every degraded path (`'cancelled'` when interrupted); the caller logs
   *  it and applies its fail-open shape. */
  error?: string;
  /** Set when the runner THREW (not a clean `session-failed`): `crashError` carries
   *  the original thrown value so the caller can apply its own crash policy —
   *  fail-open log-and-degrade, or re-throw into the scan-level `runner-crash` path. */
  crashed?: boolean;
  crashError?: unknown;
}

/**
 * Run one tail session with exactly one corrective retry on an unparseable answer.
 * Mirrors the base {@link ScanManager}'s per-item retry: on a parse `error` it
 * re-asks ONCE with the strict-JSON reminder rather than silently degrading. A
 * session failure (no result), a second unparseable answer, a cancel, or a crash all
 * degrade to a result WITHOUT `value` (plus `error`) — this never throws.
 */
export async function runTailSession<T>(
  args: TailSessionArgs<T>,
): Promise<TailSessionResult<T>> {
  const usage: TokenUsage = { ...EMPTY_USAGE };
  let costUsd = 0;

  if (args.isCancelled?.()) {
    return { usage, costUsd, error: 'cancelled' };
  }

  // Throttled progress so the (serial) tail shows life in the terminal instead of
  // running silent — its events never reach the wire.
  const heartbeat = makeHeartbeat(args.logger, `[${args.label}]`);
  const passName = args.label.split(':').pop() ?? args.label;

  // Spin one session for `prompt`, accumulating usage/cost into the shared totals.
  // Factored out so the corrective retry reuses the exact runner config.
  const runSession = async (
    prompt: string,
  ): Promise<{ result?: string; error?: string; reason?: SessionFailedReason }> => {
    let result: string | undefined;
    let error: string | undefined;
    let reason: SessionFailedReason | undefined;
    const effort = args.command.effort ?? args.config.effort;
    const runner = args.runnerFactory(
      {
        sessionId: -1,
        prompt,
        model: args.command.model ?? args.config.model,
        ...(effort ? { effort } : {}),
        permissionMode: 'dontAsk',
        permissionPolicy: args.config.permissions,
        cwd: args.command.projectPath,
        apiKeyFallback: args.apiKeyFallback,
        settingSources: args.config.settingSources,
        todoFeatureEnabled: false,
        appendSystemPrompt: args.persona,
        allowedTools: [...args.tools.allowed],
        disallowedTools: [...args.tools.disallowed],
        maxTurns: args.maxTurns ?? DEFAULT_MAX_TURNS,
        ...(args.maxBudgetUsd !== undefined
          ? { maxBudgetUsd: args.maxBudgetUsd }
          : {}),
      },
      (event) => {
        if (event.type === 'session-completed') {
          result = event.result;
          costUsd += event.costUsd ?? 0;
          if (event.usage !== undefined) addUsage(usage, event.usage);
        } else if (event.type === 'session-failed') {
          error = event.message;
          reason = event.reason;
        } else {
          heartbeat(event);
        }
      },
      args.logger?.child(args.label.replace(/:/g, '-')),
    );

    args.runners?.add(runner);
    try {
      await runner.run();
    } finally {
      args.runners?.delete(runner);
    }
    return { result, error, reason };
  };

  try {
    const first = await runSession(args.prompt);
    if (args.isCancelled?.()) {
      return { usage, costUsd, error: 'cancelled' };
    }
    if (first.result === undefined) {
      // Session failed → no value; the caller applies its fail-open shape.
      return {
        usage,
        costUsd,
        error:
          first.error ??
          (first.reason !== undefined ? `${passName} ${first.reason}` : 'no result'),
      };
    }

    let parsed = args.parse(first.result);
    if (parsed.error !== undefined) {
      // One corrective retry with the strict-JSON reminder (mirrors the lens passes).
      args.logger?.debug(
        `${args.label.split(':').join(' ')} produced no JSON; retrying`,
        { runId: args.command.runId },
      );
      const retry = await runSession(`${args.prompt}${args.retryReminder}`);
      if (args.isCancelled?.()) {
        return { usage, costUsd, error: 'cancelled' };
      }
      // A retry that also failed keeps the FIRST parse outcome (degrade, not replace).
      if (retry.result !== undefined) parsed = args.parse(retry.result);
    }

    return {
      ...(parsed.value !== undefined ? { value: parsed.value } : {}),
      usage,
      costUsd,
      ...(parsed.error !== undefined ? { error: parsed.error } : {}),
    };
  } catch (error) {
    // A thrown runner (or any unexpected error). Surface it with the accumulated
    // usage/cost; the CALLER owns the crash policy (fail-open vs re-throw).
    return {
      usage,
      costUsd,
      error: error instanceof Error ? error.message : String(error),
      crashed: true,
      crashError: error,
    };
  }
}
