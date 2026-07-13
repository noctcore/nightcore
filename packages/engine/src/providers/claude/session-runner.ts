/**
 * Drives a single Claude Agent SDK `query()` loop for one Nightcore session:
 * delegates SDK `Options` construction to [`SessionOptionsBuilder`], translates
 * each `SDKMessage` into `NightcoreEvent`s (via `translateMessage`), proxies
 * control requests (interrupt/setModel/permissions/questions), and degrades
 * crashes into `session-failed` events rather than throwing.
 *
 * Cohesive sub-concerns live in siblings: the streaming-input queue
 * (`input-stream-queue.ts`), idle watchdog (`idle-watchdog.ts`), control-probe
 * surface (`control-probe.ts`), guard wiring (`session-guards.ts`), and the
 * `session-failed` builder (`session-failure.ts`). This module keeps the turn
 * loop and the {@link AgentSession} surface.
 */
import type {
  AutonomyLevel,
  ModelDescriptor,
  NightcoreEvent,
  PermissionMode,
  ProviderConfigSnapshot,
  QuestionAnswer,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { SessionLedger } from '../../util/session-ledger.js';
import type { AgentSession } from '../agent-provider.js';
import { autonomyToPermissionMode } from './capabilities.js';
import { ControlProbe } from './control-probe.js';
import type { HookBus } from './hook-bus.js';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  IDLE_STALLED,
  nextWithIdleDeadline,
} from './idle-watchdog.js';
import { InputStreamQueue } from './input-stream-queue.js';
import { toModelDescriptor } from './mappers.js';
import type { ApprovalDecision, PermissionLayer } from './permission-layer.js';
import { ProviderConfigReader } from './provider-config.js';
import { ASK_USER_QUESTION_DIALOG, type QuestionLayer } from './question-layer.js';
import { checkClaudeCliVersion, resolveClaudeBinary } from './resolve-claude-binary.js';
import { prepareWriteSandbox } from './sandbox.js';
import {
  type AgentInfo,
  type McpServerStatus,
  type ModelInfo,
  type Query,
  query,
  type RewindFilesResult,
  type SDKControlGetContextUsageResponse,
  type SDKControlInitializeResponse,
  type SlashCommand,
  translateMessage,
} from './sdk-adapter.js';
import { CLAUDE_CLI_MISSING_MESSAGE, sessionFailedEvent } from './session-failure.js';
import { createSessionGuards } from './session-guards.js';
import { SessionOptionsBuilder, type SessionRunnerConfig } from './session-options.js';

// `SessionRunnerConfig` is re-exported here because the engine façade (`index.ts`)
// and the scan managers import it from this module — keeping that public path
// stable. The option-composition surface itself lives in `session-options.ts` so
// it is unit-testable without spinning a query.
export type { SessionRunnerConfig } from './session-options.js';

/**
 * Owns a single SDK `query()` loop and translates each `SDKMessage` into a
 * `NightcoreEvent`. Control methods (`interrupt`, `setModel`, `setPermissionMode`,
 * `streamInput`) proxy to the SDK `Query`. Uses streaming input mode (prompt is an
 * `AsyncIterable<SDKUserMessage>`) because the SDK's control requests are only
 * available then.
 */
export class SessionRunner implements AgentSession {
  private query?: Query;
  private readonly abort = new AbortController();
  private readonly permissions: PermissionLayer;
  private readonly questions: QuestionLayer;
  private readonly hooks: HookBus;
  /** The session flight recorder (module #5): appends every PreToolUse gate
   *  evaluation + start/end markers to the per-task ledger the core computed.
   *  Undefined ⇒ no `ledgerPath` on the command (probes, no project root). */
  private readonly ledger?: SessionLedger;
  /** Composes the SDK `Options` from `cfg` for both the run loop and the probes. */
  private readonly optionsBuilder: SessionOptionsBuilder;
  /** Idle watchdog deadline (ms) for the main run loop. Resolved once from `cfg`. */
  private readonly idleTimeoutMs: number;
  /** Streaming input plumbing: a queue of user messages + a parked waiter. */
  private readonly input = new InputStreamQueue();
  /** The read-only control-probe surface (model list / MCP / skills / subagents /
   *  init). */
  private readonly probe: ControlProbe;

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
    const guards = createSessionGuards(cfg, emit, this.ledger, logger);
    this.hooks = guards.hooks;
    this.permissions = guards.permissions;
    this.questions = guards.questions;
    this.probe = new ControlProbe(
      () => this.query,
      () => this.optionsBuilder.base(),
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
    // finally: every exit path (terminal, crash, CLI-missing preflight) closes it.
    this.ledger?.recordSessionStart(this.cfg.sessionId);
    try {
      await this.runQueryLoop();
    } finally {
      this.ledger?.recordSessionEnd(this.cfg.sessionId);
    }
  }

  private async runQueryLoop(): Promise<void> {
    // Preflight: the Claude CLI is a REQUIRED, user-installed prerequisite that
    // Nightcore does not bundle. If nothing resolves, fail fast with actionable
    // guidance through the same degrade-not-throw `session-failed` channel, rather
    // than let the SDK boot and crash at init with a cryptic message.
    const claudePath = resolveClaudeBinary();
    if (claudePath === undefined) {
      this.emitClaudeCliMissing();
      return;
    }

    // Warn (never fail) if the resolved external CLI is below the SDK's expected
    // floor — the version-pinned SDK drives whatever `claude` is on PATH.
    const versionWarning = checkClaudeCliVersion(claudePath);
    if (versionWarning !== undefined) {
      this.logger?.warn(versionWarning, { claudePath });
    }

    this.input.push(this.cfg.prompt, this.cfg.images);

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
    // SDK's executable for a Seatbelt wrapper that denies file-writes outside the
    // session's writable roots (closing the lexical PreToolUse gate's redirect /
    // symlink gaps). When the host can't provide it, `prepareWriteSandbox` warns
    // and returns undefined — the session runs unwrapped (fail-open: default-off).
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
      this.query = query({ prompt: this.input.stream(), options });
      // The terminal `result` never carries the assistant-level error
      // (auth/rate-limit/overloaded/…); track the most recent one off the assistant
      // frames so `translateResult` can refine an otherwise-`unknown` reason.
      let assistantError: string | undefined;
      // Drive the iterator by hand (not `for await`) so each `next()` can race the
      // idle watchdog — a wedged subprocess would otherwise hang the loop forever.
      const iterator = this.query[Symbol.asyncIterator]();
      for (;;) {
        const next = await nextWithIdleDeadline(iterator, {
          idleTimeoutMs: this.idleTimeoutMs,
          awaitingHumanDecision: () => this.awaitingHumanDecision(),
        });
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
          this.input.close();
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

  /** True while the run is legitimately parked awaiting a HUMAN decision — a pending
   *  interactive permission (incl. a plan-mode `ExitPlanMode`) or `AskUserQuestion`.
   *  The idle watchdog consults this so it NEVER trips while a person is being waited
   *  on (T6 #147; see `idle-watchdog.ts` for the full rationale). */
  private awaitingHumanDecision(): boolean {
    return this.permissions.hasPending() || this.questions.hasPending();
  }

  /**
   * Handle a wedged stream: emit a `session-failed` (`reason: 'runner-crash'`)
   * through the degrade-not-throw channel so the slot is retired, then tear the
   * subprocess down (abort + best-effort interrupt). Distinct from `handleCrash` so
   * an idle-stall reports as a runner crash, not `aborted` — we abort AFTER
   * classifying, so the abort flag must not decide the reason.
   */
  private handleStall(): void {
    this.logger?.warn(
      'session runner stream stalled — no SDK message within idle deadline',
      { sessionId: this.cfg.sessionId, idleTimeoutMs: this.idleTimeoutMs },
    );
    const message = `stream stalled: no SDK activity for ${this.idleTimeoutMs}ms`;
    this.emit(sessionFailedEvent(this.cfg.sessionId, 'runner-crash', message));
    this.input.close();
    this.abort.abort();
    void this.query?.interrupt().catch((error: unknown) => {
      this.logger?.debug('stall teardown interrupt failed', error);
    });
  }

  /** Stream additional user input into a running session. */
  streamInput(text: string): void {
    this.input.push(text);
  }

  async interrupt(): Promise<void> {
    this.abort.abort();
    await this.query?.interrupt().catch((error) => {
      this.logger?.debug('interrupt() rejected (likely already stopping)', error);
    });
  }

  async setModel(model: string): Promise<void> {
    // Mirror interrupt(): a control request that rejects mid-teardown / on a closed
    // transport degrades to a no-op with a session-scoped log, not a bubbled error.
    await this.query?.setModel(model).catch((error: unknown) => {
      this.logger?.warn('setModel rejected (session may be stopping)', error);
    });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // Same degrade-not-throw contract as setModel()/interrupt().
    await this.query?.setPermissionMode(mode).catch((error: unknown) => {
      this.logger?.warn('setPermissionMode rejected (session may be stopping)', error);
    });
  }

  /** The neutral {@link AgentSession} autonomy control: lowers the wire's neutral
   *  {@link AutonomyLevel} to an SDK `setPermissionMode` request via {@link
   *  autonomyToPermissionMode}, so the supervisor never touches an SDK mode string. */
  async setAutonomy(autonomy: AutonomyLevel): Promise<void> {
    await this.setPermissionMode(autonomyToPermissionMode(autonomy));
  }

  /** Live context-window usage (`Query.getContextUsage()`); `undefined` when no
   *  live query is open. */
  async contextUsage(): Promise<SDKControlGetContextUsageResponse | undefined> {
    return this.query?.getContextUsage();
  }

  /** Rewind this session's tracked file changes to a prior user message
   *  (`Query.rewindFiles()`). Requires `enableFileCheckpointing`; `undefined` when
   *  no live query is open. */
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

  /** Fetch the SDK's dynamic model list ({@link ControlProbe}). Degrades to `[]`. */
  supportedModels(): Promise<ModelInfo[]> {
    return this.probe.supportedModels();
  }

  /** The {@link AgentSession} model list: the SDK's dynamic models mapped to wire
   *  `ModelDescriptor`s so the supervisor never touches an SDK `ModelInfo`. */
  async listModels(): Promise<ModelDescriptor[]> {
    return (await this.probe.supportedModels()).map(toModelDescriptor);
  }

  /** The {@link AgentSession} provider-config read: the resolved, scope-aware config
   *  for `projectPath`, probed off this runner's shared subprocess, as a wire
   *  {@link ProviderConfigSnapshot}. */
  async probeConfig(projectPath: string): Promise<ProviderConfigSnapshot> {
    return new ProviderConfigReader(this.logger?.child('provider-config')).read(
      this,
      projectPath,
    );
  }

  /** The SDK's resolved MCP server status ({@link ControlProbe}). */
  mcpServerStatus(cwdOverride?: string): Promise<McpServerStatus[]> {
    return this.probe.mcpServerStatus(cwdOverride);
  }

  /** The SDK's resolved slash commands (skills) for the project ({@link ControlProbe}). */
  supportedCommands(cwdOverride?: string): Promise<SlashCommand[]> {
    return this.probe.supportedCommands(cwdOverride);
  }

  /** The SDK's resolved subagents for the project ({@link ControlProbe}). */
  supportedAgents(cwdOverride?: string): Promise<AgentInfo[]> {
    return this.probe.supportedAgents(cwdOverride);
  }

  /** The SDK's initialize response ({@link ControlProbe}). */
  initializationResult(
    cwdOverride?: string,
  ): Promise<SDKControlInitializeResponse | undefined> {
    return this.probe.initializationResult(cwdOverride);
  }

  /** Run one SDK control request against a probe query (reused live or transient),
   *  returning `fallback` on any failure — the seam the provider-config inspector
   *  reads its whole snapshot off ONE shared probe through. */
  async withProbe<T>(
    body: (q: Query) => Promise<T>,
    fallback: T,
    cwdOverride?: string,
  ): Promise<T> {
    return this.probe.withProbe(body, fallback, cwdOverride);
  }

  /** Emit the friendly preflight failure when no `claude` resolves on disk. Uses
   *  the same `session-failed` shape and input-close as `handleCrash` so it flows
   *  through the normal degrade-not-throw channel to the board/transcript. */
  private emitClaudeCliMissing(): void {
    this.logger?.warn(CLAUDE_CLI_MISSING_MESSAGE);
    this.emit(
      sessionFailedEvent(this.cfg.sessionId, 'runner-crash', CLAUDE_CLI_MISSING_MESSAGE),
    );
    this.input.close();
  }

  private handleCrash(error: unknown): void {
    const aborted = this.abort.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    this.logger?.warn('session runner crashed', error);
    const reason = aborted ? 'aborted' : 'runner-crash';
    this.emit(sessionFailedEvent(this.cfg.sessionId, reason, message));
    this.input.close();
  }
}
