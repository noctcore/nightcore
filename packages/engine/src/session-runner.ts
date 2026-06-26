import type {
  EffortLevel,
  McpServerEntry,
  NightcoreEvent,
  PermissionMode,
  PermissionPolicy,
  QuestionAnswer,
  SettingSource,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';
import {
  query,
  translateMessage,
  type AgentInfo,
  type McpServerConfig,
  type McpServerStatus,
  type ModelInfo,
  type Options,
  type Query,
  type RewindFilesResult,
  type SDKControlGetContextUsageResponse,
  type SDKControlInitializeResponse,
  type SDKUserMessage,
  type SlashCommand,
} from './sdk-adapter.js';
import { PermissionLayer, type ApprovalDecision } from './permission-layer.js';
import { QuestionLayer, ASK_USER_QUESTION_DIALOG } from './question-layer.js';
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

/**
 * Actionable guidance shown when no `claude` resolves at session start. Nightcore
 * does NOT bundle the Claude CLI — the user installs it themselves. The install
 * command is the canonical method from the Claude Code setup docs (the install
 * script; npm global install is deprecated upstream), picked per platform so a
 * Windows user gets the PowerShell command, not the macOS/Linux one. Static
 * text, no secrets.
 */
const CLAUDE_INSTALL_COMMAND =
  process.platform === 'win32'
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash';
const CLAUDE_CLI_MISSING_MESSAGE =
  'Claude CLI not found. Nightcore requires the Claude CLI — install it with ' +
  `\`${CLAUDE_INSTALL_COMMAND}\` ` +
  '(see https://code.claude.com/docs/en/setup), then retry.';

/**
 * Translate the user-configured external MCP server entries (the `transport`-tagged
 * contract shape) into the SDK's `Options.mcpServers` map (`Record<name,
 * McpServerConfig>`). Pure, so it is unit-testable without spinning a query.
 *
 * Three translations matter:
 *  - filter to `enabled` entries (the Rust core already does this, but re-filtering
 *    here keeps the helper correct on any caller);
 *  - the entry `name` becomes the record KEY (the SDK keys on it, and it is the
 *    `mcp__<name>__*` tool prefix) — a later duplicate name wins (last write);
 *  - `transport` → the SDK's `type`: OMITTED for stdio (the SDK's `type?: 'stdio'`
 *    defaults to stdio), SET to `'http'`/`'sse'` for the remote transports.
 *
 * Returns `undefined` when no enabled entry survives, so the caller can omit the
 * `mcpServers` key entirely (byte-identical to the pre-feature options).
 */
export function toSdkMcpServers(
  entries: McpServerEntry[] | undefined,
): Record<string, McpServerConfig> | undefined {
  if (entries === undefined || entries.length === 0) return undefined;
  const servers: Record<string, McpServerConfig> = {};
  for (const entry of entries) {
    if (!entry.enabled) continue;
    const { config } = entry;
    if (config.transport === 'stdio') {
      // stdio: OMIT `type` (the SDK defaults it). Only set `env` when non-empty so
      // the options stay minimal.
      servers[entry.name] = {
        command: config.command,
        args: config.args,
        ...(Object.keys(config.env).length > 0 ? { env: config.env } : {}),
      };
    } else {
      // http / sse: SET `type` to the transport; only set `headers` when non-empty.
      servers[entry.name] = {
        type: config.transport,
        url: config.url,
        ...(Object.keys(config.headers).length > 0
          ? { headers: config.headers }
          : {}),
      };
    }
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
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
  /** External MCP servers to inject for this session (`Options.mcpServers`,
   *  `sdk.d.ts:1620`). Folded into the SDK options by `name`, ADDITIVELY over the
   *  user's native `.mcp.json`/`~/.claude.json` (we never set `strictMcpConfig`).
   *  The Rust core already filters to `enabled` entries, but `toSdkMcpServers`
   *  re-filters defensively. Absent/empty ⇒ no `mcpServers` key is set (the
   *  pre-feature shape). Values in `env`/`headers` may carry secrets — never logged
   *  at info/telemetry. */
  mcpServers?: McpServerEntry[];
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
  private readonly questions: QuestionLayer;
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
    this.questions = new QuestionLayer(
      (req) =>
        this.emit({
          type: 'question-required',
          sessionId: cfg.sessionId,
          requestId: req.requestId,
          ...(req.toolUseId !== undefined ? { toolUseId: req.toolUseId } : {}),
          questions: req.questions,
        }),
      logger,
    );
  }

  /** Drive the query loop to completion. Resolves when the session reaches a
   *  terminal state; never rejects — failures surface as `session-failed`
   *  events and a returned status (degrade, don't throw). */
  async run(): Promise<void> {
    // Preflight: the Claude CLI is a REQUIRED, user-installed prerequisite —
    // Nightcore does not bundle it. If `resolveClaudeBinary()` finds nothing on
    // disk, the SDK would boot and then crash at session init with a cryptic
    // "Native CLI binary not found" message. Fail fast with actionable guidance
    // instead, surfaced through the same degrade-not-throw `session-failed`
    // channel (reuses `reason: 'runner-crash'`, the reason this case already
    // maps to today) so it reaches the board/transcript like any other failure.
    if (resolveClaudeBinary() === undefined) {
      this.emitClaudeCliMissing();
      return;
    }

    this.enqueueInput(this.cfg.prompt);

    const options: Options = {
      ...this.baseOptions(),
      model: this.cfg.model,
      permissionMode: this.cfg.permissionMode,
      includePartialMessages: true,
      canUseTool: this.permissions.canUseTool,
      // AskUserQuestion is delivered as a `request_user_dialog` of this kind, NOT
      // via canUseTool. Declaring ONLY this dialog kind opts the session into
      // receiving it (the CLI fails closed on undeclared kinds) while leaving
      // every other dialog kind on its existing no-dialog/canUseTool behavior.
      onUserDialog: this.questions.onUserDialog,
      supportedDialogKinds: [ASK_USER_QUESTION_DIALOG],
      // Native SDK tools only — the agent uses the SDK's native
      // Read/Write/Edit/Bash/Grep/Glob (the Claude-Code mental model); Nightcore
      // ships no in-house custom tools and registers no IN-PROCESS MCP server.
      // (User-configured EXTERNAL MCP servers are a separate thing: they ride
      // `Options.mcpServers`, folded in via `baseOptions`.) The `ToolRegistry` is
      // kept solely for risk metadata via `riskOf`, which classifies the native
      // tools so the PermissionLayer auto-allows safe reads and still prompts on
      // writes/shell — and an unknown `mcp__*` tool from an external server is
      // already classified `dangerous`, so it always prompts (in non-bypass mode).
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
      // Union the policy deny list into `disallowedTools` so that a configured
      // `permissions.deny` entry is hard-blocked even under `bypassPermissions`
      // mode (where `canUseTool` is never called by the SDK). The SDK enforces
      // `disallowedTools` regardless of permission mode — this is the correct
      // enforcement seam. Preset-provided entries are preserved (union, not
      // overwrite). An empty deny list is a no-op: the result collapses back to
      // the preset value (or is omitted when both are absent/empty).
      ...((): { disallowedTools?: string[] } => {
        const preset = this.cfg.disallowedTools ?? [];
        const denied = this.cfg.permissionPolicy.deny;
        if (denied.length === 0) {
          return preset.length > 0 ? { disallowedTools: preset } : {};
        }
        const merged = [...new Set([...preset, ...denied])];
        return { disallowedTools: merged };
      })(),
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
      this.questions.failAllPending();
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

  /** Resolve a parked AskUserQuestion dialog from a surface command. */
  answerQuestion(requestId: string, answer: QuestionAnswer): boolean {
    return this.questions.resolve(requestId, answer);
  }

  /**
   * Fetch the SDK's dynamic model list. `supportedModels()` is a control request
   * that needs a live streaming query: if this runner already owns one, reuse it;
   * otherwise spin a TRANSIENT query (a streaming input that sends no user turn),
   * ask, then tear it down via its abort controller in `finally` so no subprocess
   * leaks. Degrades to `[]` on any error.
   */
  async supportedModels(): Promise<ModelInfo[]> {
    return this.probeControl((q) => q.supportedModels(), []);
  }

  /**
   * Read the SDK's resolved MCP server status (the provider-config inspector). The
   * SDK applies scope precedence and reports each server's live connection status,
   * so this is authoritative over hand-parsing `.mcp.json`. Probes transiently
   * (no model turn) on the `supportedModels()` template; degrades to `[]`.
   * `cwdOverride` re-roots resolution at a project root other than this runner's.
   */
  async mcpServerStatus(cwdOverride?: string): Promise<McpServerStatus[]> {
    return this.probeControl((q) => q.mcpServerStatus(), [], cwdOverride);
  }

  /**
   * Read the SDK's resolved slash commands (skills surface as slash commands) for
   * the project (the provider-config inspector). Probes transiently; degrades to
   * `[]`. `cwdOverride` re-roots resolution at a project root.
   */
  async supportedCommands(cwdOverride?: string): Promise<SlashCommand[]> {
    return this.probeControl((q) => q.supportedCommands(), [], cwdOverride);
  }

  /**
   * Read the SDK's resolved subagents (invokable via the Task tool) for the
   * project (the provider-config inspector). Probes transiently; degrades to `[]`.
   * `cwdOverride` re-roots resolution at a project root.
   */
  async supportedAgents(cwdOverride?: string): Promise<AgentInfo[]> {
    return this.probeControl((q) => q.supportedAgents(), [], cwdOverride);
  }

  /**
   * Read the SDK's initialize response — the cheap scalar summary
   * (model / output style / available styles) that backs the inspector's extras
   * row. Probes transiently; degrades to `undefined`. `cwdOverride` re-roots
   * resolution at a project root.
   */
  async initializationResult(
    cwdOverride?: string,
  ): Promise<SDKControlInitializeResponse | undefined> {
    return this.probeControl(
      (q) => q.initializationResult(),
      undefined,
      cwdOverride,
    );
  }

  /**
   * Run one SDK control request against a live streaming query, returning
   * `fallback` on any failure (degrade-not-throw). Reuses this runner's open query
   * when it has one (and no cwd override is needed); otherwise spins a TRANSIENT
   * query (a streaming input that sends no user turn), asks, and tears it down via
   * its abort controller in `finally` so no subprocess leaks — the exact lifecycle
   * `supportedModels()` proved. `cwdOverride` forces the transient path (the live
   * query is rooted at this runner's own cwd, which may differ).
   */
  private async probeControl<T>(
    call: (q: Query) => Promise<T>,
    fallback: T,
    cwdOverride?: string,
  ): Promise<T> {
    return this.withProbe((q) => call(q), fallback, cwdOverride);
  }

  /**
   * Open ONE transient probe (or reuse this runner's live query when no cwd
   * override is needed) and hand it to `body`, returning `fallback` if the probe
   * itself can't be opened. The single subprocess is shared across every control
   * method `body` calls — letting the provider-config inspector read MCP / skills /
   * subagents / init off ONE probe while isolating per-call failures inside `body`
   * (so one failing section becomes that section's `unavailable`, never a failed
   * snapshot). The query is torn down via its abort controller in `finally`.
   */
  async withProbe<T>(
    body: (q: Query) => Promise<T>,
    fallback: T,
    cwdOverride?: string,
  ): Promise<T> {
    if (this.query && cwdOverride === undefined) {
      return body(this.query);
    }

    const abort = new AbortController();
    let transient: Query | undefined;
    try {
      transient = query({
        prompt: emptyInputStream(abort.signal),
        options: {
          ...this.baseOptions(),
          ...(cwdOverride !== undefined ? { cwd: cwdOverride } : {}),
          abortController: abort,
        },
      });
      return await body(transient);
    } catch (error) {
      this.logger?.debug('control probe transient query failed', error);
      return fallback;
    } finally {
      abort.abort();
      await transient?.interrupt().catch((error: unknown) => {
        // Teardown best-effort: the abort above already tore the query down, so an
        // interrupt rejection here is expected and harmless — record it at debug
        // rather than swallowing it silently.
        this.logger?.debug('probe teardown interrupt failed', error);
      });
    }
  }

  /** SDK options shared by the main run loop and the transient model probe. Auth:
   *  never pass an apiKey — the SDK's bundled CLI resolves the user's local Claude
   *  credentials (~/.claude); ANTHROPIC_API_KEY in the env is honored as a
   *  fallback automatically. `pathToClaudeCodeExecutable` is set whenever
   *  `resolveClaudeBinary()` finds a real, on-disk, executable `claude` (the SDK's
   *  own version-pinned binary preferred) — required for the `bun build --compile`
   *  distributable, whose `$bunfs` bundling breaks the SDK's self-resolution; it
   *  stays unset only when nothing verifiable resolves, leaving the SDK's default
   *  resolution in place. */
  private baseOptions(): Options {
    const claudePath = resolveClaudeBinary();
    const hasSettingSources = this.cfg.settingSources.length > 0;
    // Inject the configured external MCP servers HERE (not only in `run()`) so the
    // SAME merged set the run uses also reaches the transient probe that backs the
    // provider-config inspector (`withProbe` → `baseOptions`). Additive over the
    // user's native config (no `strictMcpConfig`); an empty/absent list leaves the
    // key unset, byte-identical to the pre-feature options.
    const mcpServers = toSdkMcpServers(this.cfg.mcpServers);
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
      // Configured external MCP servers, additive over the user's native config.
      // Shared by the run and the inspector probe (both spread `baseOptions`).
      ...(mcpServers !== undefined ? { mcpServers } : {}),
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

  /** Emit the friendly preflight failure when no `claude` resolves on disk. Uses
   *  the same `session-failed` shape and input-close as `handleCrash` so it flows
   *  through the normal degrade-not-throw channel to the board/transcript. */
  private emitClaudeCliMissing(): void {
    this.logger?.warn(CLAUDE_CLI_MISSING_MESSAGE);
    this.emit({
      type: 'session-failed',
      sessionId: this.cfg.sessionId,
      reason: 'runner-crash',
      message: CLAUDE_CLI_MISSING_MESSAGE,
    });
    this.closeInput();
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
