import type {
  EffortLevel,
  NightcoreEvent,
  PermissionMode,
  PermissionPolicy,
  SettingSource,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';
import {
  query,
  translateMessage,
  type ModelInfo,
  type Options,
  type Query,
  type RewindFilesResult,
  type SDKControlGetContextUsageResponse,
  type SDKUserMessage,
} from './sdk-adapter.js';
import { PermissionLayer, type ApprovalDecision } from './permission-layer.js';
import { ToolRegistry } from './tool-registry.js';
import { HookBus } from './hook-bus.js';
import { resolveClaudeBinary } from './resolve-claude-binary.js';
import { nightcoreAgents } from './agent-presets.js';

/**
 * A streaming input that yields NO user message and parks until `signal` aborts.
 * Used by the transient model probe so the SDK enters streaming mode (control
 * requests like `supportedModels()` require it) without starting a real turn.
 *
 * Deliberately yield-less: it must be an async generator to satisfy the SDK's
 * streaming-input contract, but it never emits a turn — it just keeps the input
 * stream open until teardown.
 */
// eslint-disable-next-line require-yield
async function* emptyInputStream(
  signal: AbortSignal,
): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export interface SessionRunnerConfig {
  sessionId: number;
  prompt: string;
  model: string;
  /** Reasoning effort for the session. Fixed at query construction — the SDK has
   *  no live `setEffort()`, so a surface's effort choice applies to the next
   *  session. Omitted = let the model decide. */
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  permissionPolicy: PermissionPolicy;
  cwd: string;
  /** When true, an `ANTHROPIC_API_KEY` is present and used as a fallback. Auth
   *  otherwise flows entirely through the local Claude CLI credentials — the
   *  runner passes NO apiKey itself (see README auth section). */
  apiKeyFallback: boolean;
  /** On-disk settings sources the SDK loads (skills/commands/agents/CLAUDE.md).
   *  Empty = strict isolation (no skills loaded, no `Skill` option set). */
  settingSources: SettingSource[];
  /** Enable the SDK's task/todo tracking. REQUIRED for the `task_*` system
   *  messages (→ `task-updated` events) to be emitted. */
  todoFeatureEnabled: boolean;
  /** Appended to the SDK system prompt (M4 kind preset). Omitted = no append. */
  appendSystemPrompt?: string;
  /** Tools to explicitly allow (M4 kind preset, SDK `allowedTools`). */
  allowedTools?: string[];
  /** Tools to deny (M4 kind preset, SDK `disallowedTools`). */
  disallowedTools?: string[];
  /** Autonomy ceiling: max conversation turns before the SDK stops the query
   *  (`Options.maxTurns`, `sdk.d.ts:1587`). A hit ceiling returns an
   *  `error_max_turns` result → `session-failed { reason: 'max-turns' }`.
   *  Resolved by the manager (per-task override → config default). */
  maxTurns?: number;
  /** Autonomy ceiling: max spend in USD before the SDK stops the query
   *  (`Options.maxBudgetUsd`, `sdk.d.ts:1591`). A hit ceiling returns an
   *  `error_max_budget_usd` result → `session-failed { reason: 'max-budget' }`.
   *  Omitted ⇒ uncapped. Resolved by the manager (per-task override → config). */
  maxBudgetUsd?: number;
  /** Resume a prior SDK session by its UUID (`Options.resume`, `sdk.d.ts:1713`).
   *  Set on the recovery path when a persisted `sdkSessionId` exists. Omitted ⇒
   *  a cold (fresh) session. */
  resumeSessionId?: string;
  /** Enable SDK file checkpointing (`Options.enableFileCheckpointing`,
   *  `sdk.d.ts:1388`) so the session's file changes can be rewound via
   *  `rewindFiles()`. Off by default (legacy behavior). */
  enableFileCheckpointing?: boolean;
}

/**
 * Owns a single SDK `query()` loop and translates each `SDKMessage` into a
 * `NightcoreEvent`. Control methods (`interrupt`, `setModel`,
 * `setPermissionMode`, `streamInput`) proxy to the SDK `Query`.
 *
 * Uses streaming input mode (prompt is an `AsyncIterable<SDKUserMessage>`) so
 * the SDK's control requests are available — `interrupt()` / `setModel()` etc.
 * are only supported in streaming mode.
 */
export class SessionRunner {
  private query?: Query;
  private readonly abort = new AbortController();
  private readonly permissions: PermissionLayer;
  private readonly registry = new ToolRegistry();
  private readonly hooks: HookBus;

  /** Streaming input plumbing: a queue of user messages + a waiter the input
   *  generator parks on between messages. */
  private readonly inputQueue: SDKUserMessage[] = [];
  private inputWaiter?: () => void;
  private inputClosed = false;

  constructor(
    private readonly cfg: SessionRunnerConfig,
    private readonly emit: (event: NightcoreEvent) => void,
    private readonly logger?: Logger,
  ) {
    this.hooks = new HookBus(logger);
    this.permissions = new PermissionLayer(
      cfg.permissionPolicy,
      (req) =>
        this.emit({
          type: 'permission-required',
          sessionId: cfg.sessionId,
          requestId: req.requestId,
          toolName: req.toolName,
          input: req.input,
          risk: req.risk,
          title: req.title,
        }),
      (name) => this.registry.riskOf(name),
      logger,
    );
  }

  /** Drive the query loop to completion. Resolves when the session reaches a
   *  terminal state; never rejects — failures surface as `session-failed`
   *  events and a returned status (degrade, don't throw). */
  async run(): Promise<void> {
    this.enqueueInput(this.cfg.prompt);

    const options: Options = {
      ...this.baseOptions(),
      model: this.cfg.model,
      permissionMode: this.cfg.permissionMode,
      includePartialMessages: true,
      canUseTool: this.permissions.canUseTool,
      // M4.7 §A2: native SDK tools only. The custom in-process `mcp__nightcore__*`
      // server is no longer wired into sessions — the agent uses the SDK's native
      // Read/Write/Edit/Bash/Grep/Glob (the Claude-Code mental model). The
      // `ToolRegistry` is kept solely for risk metadata via `riskOf` (it still
      // classifies native read-only tools as `safe`). `@nightcore/tools` /
      // `@nightcore/mcp` stay in the tree for a later removal pass.
      hooks: this.hooks.hooks(),
      abortController: this.abort,
      ...(this.cfg.effort !== undefined ? { effort: this.cfg.effort } : {}),
      // M4.7 §A1: the SDK ignores `permissionMode: 'bypassPermissions'` unless this
      // safety flag is explicitly set. This is config (not a secret) — fine to log
      // at debug. Bypass is the user's explicit choice for an autonomous studio.
      ...(this.cfg.permissionMode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      // M4 kind preset: an absent field leaves the SDK default in place, so a
      // `build` session (no preset overrides) is byte-identical to pre-M4.
      ...(this.cfg.appendSystemPrompt !== undefined
        ? { appendSystemPrompt: this.cfg.appendSystemPrompt }
        : {}),
      ...(this.cfg.allowedTools !== undefined
        ? { allowedTools: this.cfg.allowedTools }
        : {}),
      ...(this.cfg.disallowedTools !== undefined
        ? { disallowedTools: this.cfg.disallowedTools }
        : {}),
      // Autonomy ceilings (`sdk.d.ts:1587` maxTurns / `:1591` maxBudgetUsd). An
      // absent field leaves the SDK default in place; a hit ceiling returns an
      // `error_max_turns` / `error_max_budget_usd` result the adapter maps to a
      // distinct `session-failed` reason (never a silent success).
      ...(this.cfg.maxTurns !== undefined ? { maxTurns: this.cfg.maxTurns } : {}),
      ...(this.cfg.maxBudgetUsd !== undefined
        ? { maxBudgetUsd: this.cfg.maxBudgetUsd }
        : {}),
      // Session resume (`sdk.d.ts:1713`): when a persisted SDK session id exists,
      // reattach instead of starting cold. The id is bookkeeping (not a secret),
      // but is only ever logged at debug — never at info/telemetry.
      ...(this.cfg.resumeSessionId !== undefined
        ? { resume: this.cfg.resumeSessionId }
        : {}),
      // File checkpointing (`sdk.d.ts:1388`): opt-in backend for `rewindFiles()`.
      ...(this.cfg.enableFileCheckpointing
        ? { enableFileCheckpointing: true }
        : {}),
    };

    if (this.cfg.resumeSessionId !== undefined) {
      this.logger?.debug('resuming SDK session', {
        sessionId: this.cfg.sessionId,
      });
    }

    try {
      this.query = query({ prompt: this.inputStream(), options });
      for await (const message of this.query) {
        const { events, terminal } = translateMessage(
          this.cfg.sessionId,
          message,
        );
        for (const event of events) this.emit(event);
        if (terminal) {
          this.closeInput();
          return;
        }
      }
    } catch (error) {
      this.handleCrash(error);
    } finally {
      this.permissions.failAllPending();
    }
  }

  /** Stream additional user input into a running session. */
  streamInput(text: string): void {
    this.enqueueInput(text);
  }

  async interrupt(): Promise<void> {
    this.abort.abort();
    await this.query?.interrupt().catch((error) => {
      this.logger?.debug('interrupt() rejected (likely already stopping)', error);
    });
  }

  async setModel(model: string): Promise<void> {
    await this.query?.setModel(model);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.query?.setPermissionMode(mode);
  }

  /**
   * STRETCH (engine-side proxy only): live context-window usage for this session
   * (`Query.getContextUsage()`, `sdk.d.ts:2282`). Returns `undefined` when no
   * live query is open. The NightcoreEvent + web gauge are a deferred follow-up
   * (contract §C) — this proxy is the backend hook they will consume.
   */
  async contextUsage(): Promise<SDKControlGetContextUsageResponse | undefined> {
    return this.query?.getContextUsage();
  }

  /**
   * STRETCH (engine-side proxy only): rewind this session's tracked file changes
   * to a prior user message (`Query.rewindFiles()`, `sdk.d.ts:2344`). Requires
   * the session to have been started with `enableFileCheckpointing`. Returns
   * `undefined` when no live query is open. The Rust `rewind_task` command + web
   * UI are a deferred follow-up (contract §C).
   */
  async rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<RewindFilesResult | undefined> {
    return this.query?.rewindFiles(userMessageId, options);
  }

  /** Resolve a parked interactive permission from a surface command. */
  approvePermission(requestId: string, decision: ApprovalDecision): boolean {
    return this.permissions.resolve(requestId, decision);
  }

  /**
   * Fetch the SDK's dynamic model list. `supportedModels()` is a control request
   * that needs a live streaming query: if this runner already owns one, reuse it;
   * otherwise spin a TRANSIENT query (a streaming input that sends no user turn),
   * ask, then tear it down via its abort controller in `finally` so no subprocess
   * leaks. Degrades to `[]` on any error.
   */
  async supportedModels(): Promise<ModelInfo[]> {
    if (this.query) {
      return this.query.supportedModels();
    }

    const abort = new AbortController();
    let transient: Query | undefined;
    try {
      transient = query({
        prompt: emptyInputStream(abort.signal),
        options: { ...this.baseOptions(), abortController: abort },
      });
      return await transient.supportedModels();
    } catch (error) {
      this.logger?.debug('supportedModels() transient query failed', error);
      return [];
    } finally {
      abort.abort();
      await transient?.interrupt().catch(() => {});
    }
  }

  /** SDK options shared by the main run loop and the transient model probe. Auth:
   *  never pass an apiKey — the SDK's bundled CLI resolves the user's local Claude
   *  credentials (~/.claude); ANTHROPIC_API_KEY in the env is honored as a
   *  fallback automatically. `pathToClaudeCodeExecutable` is set ONLY when the
   *  resolver names a binary (compiled-distributable case); otherwise it stays
   *  unset so the SDK's normal in-repo node_modules default applies. */
  private baseOptions(): Options {
    const claudePath = resolveClaudeBinary();
    const hasSettingSources = this.cfg.settingSources.length > 0;
    return {
      cwd: this.cfg.cwd,
      executable: 'bun',
      stderr: (data) => this.logger?.debug('[sdk stderr]', data),
      // M4.7 §A2 (settingSources reassessment): kept config-driven, NOT dropped.
      // Nightcore's permission policy already governs every run regardless of this
      // value — the harness `PermissionLayer` (`canUseTool`) plus the SDK
      // `permissionMode` are what gate tool use; `settingSources` only loads
      // skills/commands/CLAUDE.md, not permission rules. Dropping `'user'` would
      // strip the user's own skills/commands (which the config contract wants to
      // "just work") without strengthening governance, so it stays config-driven.
      // `nightcoreAgents` is passed via `Options.agents` below, so it survives
      // even when `settingSources` is `[]` (strict isolation).
      settingSources: this.cfg.settingSources,
      agents: nightcoreAgents,
      // The task/todo feature has no run-`Options` key in the pinned SDK; it is
      // toggled via the `CLAUDE_CODE_ENABLE_TASKS` env var the bundled CLI reads.
      // `Options.env` REPLACES the subprocess environment wholesale, so spread
      // `process.env` first to preserve PATH/HOME/ANTHROPIC_API_KEY. When enabled
      // we also turn on AI progress summaries so `task_progress.summary` is
      // populated for the live panel.
      env: {
        ...process.env,
        CLAUDE_CODE_ENABLE_TASKS: this.cfg.todoFeatureEnabled ? '1' : '0',
      },
      ...(this.cfg.todoFeatureEnabled ? { agentProgressSummaries: true } : {}),
      // Skills are filesystem-discovered via settingSources; only enable the
      // skills filter (which auto-adds the `Skill` tool) when at least one
      // source is loaded — with strict isolation there is nothing to enable.
      ...(hasSettingSources ? { skills: 'all' as const } : {}),
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
    };
  }

  // --- streaming input internals ---------------------------------------------

  private enqueueInput(text: string): void {
    if (this.inputClosed) return;
    this.inputQueue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.inputWaiter?.();
    this.inputWaiter = undefined;
  }

  private closeInput(): void {
    this.inputClosed = true;
    this.inputWaiter?.();
    this.inputWaiter = undefined;
  }

  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.inputQueue.length > 0) {
        yield this.inputQueue.shift() as SDKUserMessage;
      }
      if (this.inputClosed) return;
      await new Promise<void>((resolve) => {
        this.inputWaiter = resolve;
      });
    }
  }

  private handleCrash(error: unknown): void {
    const aborted = this.abort.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    this.logger?.warn('session runner crashed', error);
    this.emit({
      type: 'session-failed',
      sessionId: this.cfg.sessionId,
      reason: aborted ? 'aborted' : 'runner-crash',
      message,
    });
    this.closeInput();
  }
}
