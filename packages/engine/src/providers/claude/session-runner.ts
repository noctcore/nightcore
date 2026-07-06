/**
 * Drives a single Claude Agent SDK `query()` loop for one Nightcore session:
 * delegates SDK `Options` construction to [`SessionOptionsBuilder`], translates
 * each `SDKMessage` into `NightcoreEvent`s (via `translateMessage`), proxies
 * control requests (interrupt/setModel/permissions/questions), and degrades
 * crashes into `session-failed` events rather than throwing.
 */
import type {
  AutonomyLevel,
  ModelDescriptor,
  NightcoreEvent,
  PermissionMode,
  ProviderConfigSnapshot,
  QuestionAnswer,
  WireImage,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { ToolRegistry } from '../../policy/tool-registry.js';
import { SessionLedger } from '../../session/session-ledger.js';
import type { AgentSession } from '../agent-provider.js';
import { autonomyToPermissionMode } from './capabilities.js';
import { HookBus } from './hook-bus.js';
import { toModelDescriptor } from './mappers.js';
import { type ApprovalDecision,PermissionLayer } from './permission-layer.js';
import { ProviderConfigReader } from './provider-config.js';
import { ASK_USER_QUESTION_DIALOG,QuestionLayer } from './question-layer.js';
import { checkClaudeCliVersion, resolveClaudeBinary } from './resolve-claude-binary.js';
import { prepareWriteSandbox } from './sandbox.js';
import {
  type AgentInfo,
  detailForReason,
  type McpServerStatus,
  type ModelInfo,
  type Query,
  query,
  type RewindFilesResult,
  type SDKControlGetContextUsageResponse,
  type SDKControlInitializeResponse,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand,
  translateMessage,
} from './sdk-adapter.js';
import {
  buildUserMessageContent,
  SessionOptionsBuilder,
  type SessionRunnerConfig,
} from './session-options.js';

// The option-composition surface (`SessionOptionsBuilder` + the pure compose
// helpers) lives in `session-options.ts` so it is unit-testable without spinning a
// query. `SessionRunnerConfig` is re-exported here because the engine façade
// (`index.ts`) and the scan managers import it from this module — keeping that
// public path stable.
export type { SessionRunnerConfig } from './session-options.js';

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
 * Default idle watchdog deadline for the main run loop: 30 minutes with NO SDK
 * message resets the timer on every yield. It is deliberately generous — one
 * long tool call (a multi-minute build, a full test suite, a large download)
 * produces no intermediate SDK messages, so a tight deadline would kill healthy
 * work. Only a genuinely wedged subprocess (stopped yielding, no terminal
 * `result`) should trip it, freeing the concurrency slot it would otherwise
 * leak forever. Overridable per-session via `SessionRunnerConfig.idleTimeoutMs`.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Bounded deadline for a transient control probe (model list / MCP status /
 * slash commands / subagents / init). These are cheap control reads, not model
 * turns, so a probe that hasn't answered within this window is wedged — degrade
 * to the caller's `[]`/`undefined` fallback rather than hang the inspector.
 */
const PROBE_TIMEOUT_MS = 30 * 1000;

/** Sentinel returned by [`SessionRunner.nextWithIdleDeadline`] when the idle
 *  watchdog fires before the SDK yields the next message. */
const IDLE_STALLED = Symbol('idle-stalled');

/**
 * Owns a single SDK `query()` loop and translates each `SDKMessage` into a
 * `NightcoreEvent`. Control methods (`interrupt`, `setModel`,
 * `setPermissionMode`, `streamInput`) proxy to the SDK `Query`.
 *
 * Uses streaming input mode (prompt is an `AsyncIterable<SDKUserMessage>`) so
 * the SDK's control requests are available — `interrupt()` / `setModel()` etc.
 * are only supported in streaming mode.
 */
export class SessionRunner implements AgentSession {
  private query?: Query;
  private readonly abort = new AbortController();
  private readonly permissions: PermissionLayer;
  private readonly questions: QuestionLayer;
  private readonly registry = new ToolRegistry();
  private readonly hooks: HookBus;
  /** The session flight recorder (module #5): appends every PreToolUse gate
   *  evaluation + start/end markers to the per-task ledger the core computed.
   *  Undefined ⇒ no `ledgerPath` on the command (probes, no project root). */
  private readonly ledger?: SessionLedger;
  /** Composes the SDK `Options` from `cfg` for both the run loop and the probes. */
  private readonly optionsBuilder: SessionOptionsBuilder;
  /** Idle watchdog deadline (ms) for the main run loop — see
   *  [`DEFAULT_IDLE_TIMEOUT_MS`]. Resolved once from `cfg` at construction. */
  private readonly idleTimeoutMs: number;

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
    this.optionsBuilder = new SessionOptionsBuilder(cfg, logger);
    this.idleTimeoutMs = cfg.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.ledger =
      cfg.ledgerPath !== undefined
        ? new SessionLedger(cfg.ledgerPath, logger)
        : undefined;
    // Confine file mutations to the run cwd (worktree isolation) and enforce the
    // project's harness runtime policy (protected paths + Bash deny patterns) —
    // the PreToolUse gate enforces both even under `bypassPermissions`. The
    // flight recorder rides the same gate's decision seam (one writer sees
    // every allow AND deny).
    this.hooks = new HookBus(logger, {
      cwd: cfg.cwd,
      ...(cfg.harnessPolicy !== undefined
        ? { harnessPolicy: cfg.harnessPolicy }
        : {}),
      ...(this.ledger !== undefined
        ? { onToolDecision: this.ledger.recordToolDecision }
        : {}),
    });
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

  /** The effective autonomy ceiling this session runs under ({@link AgentSession}).
   *  The provider resolved it (override / kind preset / default); the supervisor
   *  reads it back for the session record + `session-started` event. */
  get permissionMode(): PermissionMode {
    return this.cfg.permissionMode;
  }

  /** Drive the query loop to completion. Resolves when the session reaches a
   *  terminal state; never rejects — failures surface as `session-failed`
   *  events and a returned status (degrade, don't throw). */
  async run(): Promise<void> {
    // Flight-recorder markers bracket the whole run so the Rust-side readers can
    // segment the shared per-task ledger by session. The end marker rides a
    // finally: every exit path (terminal, crash, CLI-missing preflight) closes
    // the segment.
    this.ledger?.recordSessionStart(this.cfg.sessionId);
    try {
      await this.runQueryLoop();
    } finally {
      this.ledger?.recordSessionEnd(this.cfg.sessionId);
    }
  }

  private async runQueryLoop(): Promise<void> {
    // Preflight: the Claude CLI is a REQUIRED, user-installed prerequisite —
    // Nightcore does not bundle it. If `resolveClaudeBinary()` finds nothing on
    // disk, the SDK would boot and then crash at session init with a cryptic
    // "Native CLI binary not found" message. Fail fast with actionable guidance
    // instead, surfaced through the same degrade-not-throw `session-failed`
    // channel (reuses `reason: 'runner-crash'`, the reason this case already
    // maps to today) so it reaches the board/transcript like any other failure.
    const claudePath = resolveClaudeBinary();
    if (claudePath === undefined) {
      this.emitClaudeCliMissing();
      return;
    }

    // Warn (never fail) if the resolved external CLI is below the SDK's expected
    // floor: in the shipped binary the version-pinned SDK drives whatever `claude`
    // is on PATH, whose version is uncoupled from the build-time pin. A one-time
    // probe turns silent mid-session breakage into an actionable upgrade message.
    const versionWarning = checkClaudeCliVersion(claudePath);
    if (versionWarning !== undefined) {
      this.logger?.warn(versionWarning, { claudePath });
    }

    this.enqueueInput(this.cfg.prompt, this.cfg.images);

    const options = this.optionsBuilder.run({
      canUseTool: this.permissions.canUseTool,
      // AskUserQuestion is delivered as a `request_user_dialog` of this kind, NOT
      // via canUseTool — declaring ONLY this dialog kind opts the session into it.
      onUserDialog: this.questions.onUserDialog,
      supportedDialogKinds: [ASK_USER_QUESTION_DIALOG],
      hooks: this.hooks.hooks(),
      abortController: this.abort,
    });

    // OPT-IN macOS OS-level WRITE containment (hardening module #15): swap the
    // SDK's executable for a Seatbelt wrapper that denies file-writes outside
    // the session's writable roots (cwd, worktree git common dir, temp trees,
    // Claude CLI state). Closes the lexical PreToolUse gate's documented gaps
    // (Bash redirects, symlinks) at the OS layer. When requested but the host
    // can't provide it, `prepareWriteSandbox` warns LOUDLY and returns
    // undefined — the session runs unwrapped (fail-open: default-off,
    // experimental). Probes (`withProbe`/`base()`) stay unwrapped: they never
    // run a model turn, so they perform no agent writes.
    if (this.cfg.sandboxWrites === true) {
      const sandbox = prepareWriteSandbox({
        claudePath,
        cwd: this.cfg.cwd,
        logger: this.logger,
      });
      if (sandbox !== undefined) {
        options.pathToClaudeCodeExecutable = sandbox.wrapperPath;
        this.logger?.info('OS write containment active', {
          wrapper: sandbox.wrapperPath,
          writableRoots: sandbox.writableRoots,
        });
      }
    }

    if (this.cfg.resumeSessionId !== undefined) {
      this.logger?.debug('resuming SDK session', {
        sessionId: this.cfg.sessionId,
      });
    }

    try {
      this.query = query({ prompt: this.inputStream(), options });
      // The terminal `result` message never carries the assistant-level error
      // (auth/rate-limit/overloaded/…); track the most recent one off the
      // assistant frames so `translateResult` can refine an otherwise-`unknown`
      // failure reason instead of collapsing it.
      let assistantError: string | undefined;
      // Drive the iterator by hand (not `for await`) so each `next()` can race an
      // idle watchdog: a wedged subprocess that stops yielding without a terminal
      // `result` would otherwise hang here forever, leaking the concurrency slot.
      const iterator = this.query[Symbol.asyncIterator]();
      for (;;) {
        const next = await this.nextWithIdleDeadline(iterator);
        if (next === IDLE_STALLED) {
          this.handleStall();
          return;
        }
        if (next.done === true) break;
        const message = next.value;
        if (message.type === 'assistant' && message.error !== undefined) {
          assistantError = message.error;
        }
        const { events, terminal } = translateMessage(
          this.cfg.sessionId,
          message,
          {
            ...(this.cfg.kind !== undefined ? { kind: this.cfg.kind } : {}),
            ...(assistantError !== undefined ? { assistantError } : {}),
          },
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

  /**
   * Await the iterator's next message under an idle deadline. Returns the
   * `IteratorResult` when the SDK yields (or completes) in time, or
   * [`IDLE_STALLED`] when [`idleTimeoutMs`] elapses first. The deadline is a
   * fresh timer per call, so it resets on every yielded message — only a
   * genuinely quiet (wedged) stream trips it. When the timer wins, the pending
   * `next()` is left dangling but its eventual rejection (from the teardown
   * abort) is swallowed so it never surfaces as an unhandled rejection.
   */
  private async nextWithIdleDeadline(
    iterator: AsyncIterator<SDKMessage>,
  ): Promise<IteratorResult<SDKMessage> | typeof IDLE_STALLED> {
    const nextPromise = iterator.next();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<typeof IDLE_STALLED>((resolve) => {
      timer = setTimeout(() => resolve(IDLE_STALLED), this.idleTimeoutMs);
    });
    try {
      const result = await Promise.race([nextPromise, idle]);
      if (result === IDLE_STALLED) {
        // The next() promise may reject later when teardown aborts the query —
        // attach a no-op catch now so it never bubbles as unhandled.
        void Promise.resolve(nextPromise).catch(() => {});
      }
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Handle a wedged stream: emit a `session-failed` (`reason: 'runner-crash'`,
   * 'stream stalled') through the normal degrade-not-throw channel so the board
   * shows a terminal state and the slot is retired, then tear the subprocess
   * down (abort + best-effort interrupt). Distinct from `handleCrash` so an
   * idle-stall reports as a runner crash, not `aborted` — we abort AFTER
   * classifying, so the abort flag must not decide the reason.
   */
  private handleStall(): void {
    this.logger?.warn('session runner stream stalled — no SDK message within idle deadline', {
      sessionId: this.cfg.sessionId,
      idleTimeoutMs: this.idleTimeoutMs,
    });
    {
      const message = `stream stalled: no SDK activity for ${this.idleTimeoutMs}ms`;
      this.emit({
        type: 'session-failed',
        sessionId: this.cfg.sessionId,
        reason: 'runner-crash',
        message,
        detail: detailForReason('runner-crash', message),
      });
    }
    this.closeInput();
    this.abort.abort();
    void this.query?.interrupt().catch((error: unknown) => {
      this.logger?.debug('stall teardown interrupt failed', error);
    });
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
    // Mirror interrupt(): the SDK control request can reject when the session is
    // mid-teardown or the transport has closed. Swallow that so a doomed model
    // switch degrades to a no-op with a session-scoped log rather than bubbling
    // up as a generic sidecar 'dispatch failed' warning.
    await this.query?.setModel(model).catch((error: unknown) => {
      this.logger?.warn('setModel rejected (session may be stopping)', error);
    });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // Same degrade-not-throw contract as setModel()/interrupt(): a rejected
    // control request must not surface as an unhandled sidecar dispatch error.
    await this.query?.setPermissionMode(mode).catch((error: unknown) => {
      this.logger?.warn('setPermissionMode rejected (session may be stopping)', error);
    });
  }

  /**
   * The neutral {@link AgentSession} autonomy control. Takes the wire's neutral
   * {@link AutonomyLevel} vocabulary and lowers it to the SDK `setPermissionMode`
   * control request via {@link autonomyToPermissionMode} — the Claude provider owns
   * the mapping, so the supervisor never touches an SDK mode string.
   */
  async setAutonomy(autonomy: AutonomyLevel): Promise<void> {
    await this.setPermissionMode(autonomyToPermissionMode(autonomy));
  }

  /**
   * Live context-window usage for this session (`Query.getContextUsage()`).
   * Returns `undefined` when no live query is open. This is the engine-side proxy
   * a future surface gauge can consume.
   */
  async contextUsage(): Promise<SDKControlGetContextUsageResponse | undefined> {
    return this.query?.getContextUsage();
  }

  /**
   * Rewind this session's tracked file changes to a prior user message
   * (`Query.rewindFiles()`). Requires the session to have been started with
   * `enableFileCheckpointing`. Returns `undefined` when no live query is open.
   * This is the engine-side proxy a future rewind command + UI can consume.
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
   * The {@link AgentSession} model list: the SDK's dynamic models mapped to wire
   * `ModelDescriptor`s so the supervisor never touches an SDK `ModelInfo`. Degrades
   * to `[]` via `supportedModels()`.
   */
  async listModels(): Promise<ModelDescriptor[]> {
    return (await this.supportedModels()).map(toModelDescriptor);
  }

  /**
   * The {@link AgentSession} provider-config read: the resolved, scope-aware config
   * for `projectPath`, probed off this runner's shared subprocess (reused when live,
   * transient otherwise) and returned as a wire {@link ProviderConfigSnapshot}. The
   * reader degrades per section, so the snapshot always resolves.
   */
  async probeConfig(projectPath: string): Promise<ProviderConfigSnapshot> {
    return new ProviderConfigReader(this.logger?.child('provider-config')).read(
      this,
      projectPath,
    );
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
      // Bound even the live-query reuse path: a wedged control request must
      // degrade to the fallback, not hang the inspector.
      return this.raceProbeDeadline(body(this.query), fallback);
    }

    const abort = new AbortController();
    let transient: Query | undefined;
    try {
      transient = query({
        prompt: emptyInputStream(abort.signal),
        options: {
          ...this.optionsBuilder.base(),
          ...(cwdOverride !== undefined ? { cwd: cwdOverride } : {}),
          abortController: abort,
        },
      });
      return await this.raceProbeDeadline(body(transient), fallback);
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

  /**
   * Race a control-probe promise against [`PROBE_TIMEOUT_MS`], resolving to
   * `fallback` if the probe hasn't answered in time. Keeps the provider-config
   * inspector responsive when a subprocess wedges mid-read: the section degrades
   * to `unavailable` instead of hanging the whole snapshot. A probe rejection is
   * NOT caught here — `withProbe`'s own `catch` maps it to the fallback.
   */
  private async raceProbeDeadline<T>(work: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof IDLE_STALLED>((resolve) => {
      timer = setTimeout(() => resolve(IDLE_STALLED), PROBE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([work, deadline]);
      if (result === IDLE_STALLED) {
        void Promise.resolve(work).catch(() => {});
        this.logger?.debug('control probe timed out — degrading to fallback');
        return fallback;
      }
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // --- streaming input internals ---------------------------------------------

  private enqueueInput(text: string, images: WireImage[] = []): void {
    if (this.inputClosed) return;
    this.inputQueue.push({
      type: 'user',
      message: { role: 'user', content: buildUserMessageContent(text, images) },
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
      detail: detailForReason('runner-crash', CLAUDE_CLI_MISSING_MESSAGE),
    });
    this.closeInput();
  }

  private handleCrash(error: unknown): void {
    const aborted = this.abort.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    this.logger?.warn('session runner crashed', error);
    const reason = aborted ? 'aborted' : 'runner-crash';
    this.emit({
      type: 'session-failed',
      sessionId: this.cfg.sessionId,
      reason,
      message,
      detail: detailForReason(reason, message),
    });
    this.closeInput();
  }
}
