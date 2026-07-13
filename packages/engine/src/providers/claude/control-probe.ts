/**
 * The read-only control-probe surface a `SessionRunner` exposes to the
 * provider-config inspector and the model picker: the SDK's dynamic model list,
 * MCP status, skills (slash commands), subagents, and init summary.
 *
 * A control request (`supportedModels()` et al.) needs a live streaming query. If
 * the runner already owns one (its turn loop), REUSE it; otherwise spin a
 * TRANSIENT, input-less subprocess that runs NO model turn, ask, and tear it down
 * via its abort controller so no `claude` process leaks. Every read degrades to
 * its caller's fallback (`[]` / `undefined`) rather than throwing.
 */
import type { Logger } from '@nightcore/shared';

import { withTransientProbeRetry } from './probe-retry.js';
import {
  type AgentInfo,
  type McpServerStatus,
  type ModelInfo,
  type Options,
  type Query,
  query,
  type SDKControlInitializeResponse,
  type SDKUserMessage,
  type SlashCommand,
} from './sdk-adapter.js';

/**
 * Bounded deadline for a transient control probe (model list / MCP status / slash
 * commands / subagents / init). These are cheap control reads, not model turns, so
 * a probe that hasn't answered within this window is wedged — degrade to the
 * caller's `[]`/`undefined` fallback rather than hang the inspector.
 */
export const PROBE_TIMEOUT_MS = 30 * 1000;

/** Internal sentinel: one elapsed probe deadline inside {@link
 *  ControlProbe.raceProbeDeadline}. */
const PROBE_DEADLINE = Symbol('probe-deadline');

/**
 * A streaming input that yields NO user message and parks until `signal` aborts.
 * Used by a transient probe so the SDK enters streaming mode (control requests
 * require it) without starting a real turn.
 *
 * Deliberately yield-less: it must be an async generator to satisfy the SDK's
 * streaming-input contract, but it never emits a turn — it just keeps the input
 * stream open until teardown.
 */
// eslint-disable-next-line require-yield
export async function* emptyInputStream(
  signal: AbortSignal,
): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Runs bounded SDK control reads for one session, reusing the runner's live query
 * when present or spinning an isolated transient probe otherwise. Holds no query of
 * its own — `liveQuery` reads the runner's current turn-loop query (may be
 * `undefined`), and `optionsBase` yields the shared `base()` SDK options a
 * transient probe spawns from.
 */
export class ControlProbe {
  constructor(
    private readonly liveQuery: () => Query | undefined,
    private readonly optionsBase: () => Options,
    private readonly logger?: Logger,
  ) {}

  /**
   * Hand `body` a probe query and return `fallback` when it can't answer. With a
   * live query and no cwd override, REUSE it (the turn loop owns it — a single
   * attempt, bounded by the deadline, NOT retried to avoid lifecycle races).
   * Otherwise open an isolated, read-only TRANSIENT subprocess and, per issue #252,
   * retry a transient spawn/read blip before degrading. `cwdOverride` forces the
   * transient path (the live query is rooted at the runner's own cwd, which may
   * differ). Torn down in `finally` by {@link withTransientProbeRetry}.
   */
  async withProbe<T>(
    body: (q: Query) => Promise<T>,
    fallback: T,
    cwdOverride?: string,
  ): Promise<T> {
    const live = this.liveQuery();
    if (live && cwdOverride === undefined) {
      // Live-query reuse (turn-loop-owned): one attempt, bounded by the deadline.
      return this.raceProbeDeadline(body(live), fallback);
    }
    // Isolated read-only transient probe: safe to retry a blip, then degrade.
    return withTransientProbeRetry(body, fallback, cwdOverride, {
      openProbe: (abort, cwd) =>
        query({
          prompt: emptyInputStream(abort.signal),
          options: {
            ...this.optionsBase(),
            ...(cwd !== undefined ? { cwd } : {}),
            abortController: abort,
          },
        }),
      race: (work, fallbackValue) => this.raceProbeDeadline(work, fallbackValue),
      logger: this.logger,
    });
  }

  /** Run one SDK control request against a probe query (reused live or transient),
   *  returning `fallback` on any failure (degrade-not-throw). */
  control<T>(
    call: (q: Query) => Promise<T>,
    fallback: T,
    cwdOverride?: string,
  ): Promise<T> {
    return this.withProbe((q) => call(q), fallback, cwdOverride);
  }

  /** The SDK's dynamic model list. Degrades to `[]`. */
  supportedModels(): Promise<ModelInfo[]> {
    return this.control((q) => q.supportedModels(), []);
  }

  /**
   * The SDK's resolved MCP server status (the provider-config inspector). The SDK
   * applies scope precedence and reports each server's live connection status, so
   * this is authoritative over hand-parsing `.mcp.json`. Degrades to `[]`.
   * `cwdOverride` re-roots resolution at a project root other than the runner's.
   */
  mcpServerStatus(cwdOverride?: string): Promise<McpServerStatus[]> {
    return this.control((q) => q.mcpServerStatus(), [], cwdOverride);
  }

  /** The SDK's resolved slash commands (skills surface as slash commands) for the
   *  project. Degrades to `[]`. `cwdOverride` re-roots resolution. */
  supportedCommands(cwdOverride?: string): Promise<SlashCommand[]> {
    return this.control((q) => q.supportedCommands(), [], cwdOverride);
  }

  /** The SDK's resolved subagents (invokable via the Task tool) for the project.
   *  Degrades to `[]`. `cwdOverride` re-roots resolution. */
  supportedAgents(cwdOverride?: string): Promise<AgentInfo[]> {
    return this.control((q) => q.supportedAgents(), [], cwdOverride);
  }

  /** The SDK's initialize response — the cheap scalar summary (model / output style
   *  / available styles) backing the inspector's extras row. Degrades to
   *  `undefined`. `cwdOverride` re-roots resolution. */
  initializationResult(
    cwdOverride?: string,
  ): Promise<SDKControlInitializeResponse | undefined> {
    return this.control((q) => q.initializationResult(), undefined, cwdOverride);
  }

  /**
   * Race a control-probe promise against {@link PROBE_TIMEOUT_MS}, resolving to
   * `fallback` if it hasn't answered in time. Keeps the inspector responsive when a
   * subprocess wedges mid-read: the section degrades to `unavailable` instead of
   * hanging the whole snapshot. A probe rejection is NOT caught here — {@link
   * withProbe}'s retry/degrade path maps it to the fallback.
   */
  private async raceProbeDeadline<T>(work: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof PROBE_DEADLINE>((resolve) => {
      timer = setTimeout(() => resolve(PROBE_DEADLINE), PROBE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([work, deadline]);
      if (result === PROBE_DEADLINE) {
        void Promise.resolve(work).catch(() => {});
        this.logger?.debug('control probe timed out — degrading to fallback');
        return fallback;
      }
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
