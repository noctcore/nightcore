import { EventEmitter } from 'node:events';
import type {
  Config,
  ModelDescriptor,
  NightcoreEvent,
  NightcoreEventOf,
  SessionInfo,
  SessionMessage as WireSessionMessage,
  SessionRecord,
  SessionStatus,
  SurfaceCommand,
  SurfaceQuery,
} from '@nightcore/contracts';
import { SessionStore } from '@nightcore/storage';
import { createMonotonicCounter, type Logger } from '@nightcore/shared';
import { SessionRunner } from './session-runner.js';
import { AnalysisManager } from './analysis-manager.js';
import { HarnessManager } from './harness-manager.js';
import { ScorecardManager } from './scorecard-manager.js';
import { resolveKindPreset } from './kind-presets.js';
import type { ModelInfo } from './sdk-adapter.js';
import { SessionApi, type SDKSessionInfo, type SessionMessage } from './session-api.js';
import { ProviderConfigReader } from './provider-config.js';

/**
 * Map an SDK `ModelInfo` to a contract `ModelDescriptor`. Pure so it can be
 * unit-tested without spinning a live query. The SDK marks `supportsEffort` /
 * `supportedEffortLevels` optional; default to the most-conservative values.
 */
export function toModelDescriptor(info: ModelInfo): ModelDescriptor {
  return {
    value: info.value,
    displayName: info.displayName,
    description: info.description,
    supportsEffort: info.supportsEffort ?? false,
    supportedEffortLevels: info.supportedEffortLevels ?? [],
  };
}

/** Map the SDK's `SDKSessionInfo` onto the contract `SessionInfo`, renaming
 *  `sessionId` → `sdkSessionId` (the wire vocabulary) and forwarding the rest
 *  field-for-field. Pure, so it is unit-testable without a live SDK. Optional
 *  fields are omitted when absent to match the `.optional()` wire shape. */
export function toWireSessionInfo(info: SDKSessionInfo): SessionInfo {
  return {
    sdkSessionId: info.sessionId,
    summary: info.summary,
    lastModified: info.lastModified,
    ...(info.fileSize !== undefined ? { fileSize: info.fileSize } : {}),
    ...(info.customTitle !== undefined ? { customTitle: info.customTitle } : {}),
    ...(info.firstPrompt !== undefined ? { firstPrompt: info.firstPrompt } : {}),
    ...(info.gitBranch !== undefined ? { gitBranch: info.gitBranch } : {}),
    ...(info.cwd !== undefined ? { cwd: info.cwd } : {}),
    ...(info.tag !== undefined ? { tag: info.tag } : {}),
    ...(info.createdAt !== undefined ? { createdAt: info.createdAt } : {}),
  };
}

/** Map the SDK's `SessionMessage` (snake_case, `message: unknown`) onto the
 *  contract `SessionMessage` (camelCase wire keys, `message` as an object record).
 *  A non-object `message` is coerced to an empty record so a malformed transcript
 *  line can't violate the contract. `parent_tool_use_id` is `string | null`. */
export function toWireSessionMessage(msg: SessionMessage): WireSessionMessage {
  const message =
    typeof msg.message === 'object' && msg.message !== null
      ? (msg.message as Record<string, unknown>)
      : {};
  return {
    type: msg.type,
    uuid: msg.uuid,
    sessionId: msg.session_id,
    message,
    parentToolUseId: msg.parent_tool_use_id,
  };
}

interface ManagedSession {
  id: number;
  runner: SessionRunner;
  record: SessionRecord;
}

/**
 * The supervisor. Owns a map of `sessionId → SessionRunner`, hands out monotonic
 * ids that never reset (so a late event from a torn-down runner is dropped), and
 * degrades-not-throws on crash — a runner failure surfaces as a `session-failed`
 * event, never a rejected promise.
 *
 * Generalized from shiranami's `analysis-host.ts`: same id discipline and
 * graceful-degradation semantics, but N concurrent sessions and a rich typed
 * event stream instead of a single `{ id, result }` reply.
 *
 * SPIKE: runners are in-process for now (the SDK already spawns its own CLI
 * subprocess, so an extra worker_thread per session is likely redundant
 * double-subprocessing). Whether sessions need a real OS-level worker boundary
 * for crash isolation is a deferred week-1 decision — see docs/architecture.md.
 */
export class SessionManager {
  private readonly emitter = new EventEmitter();
  private readonly nextSessionId: () => number;
  private readonly sessions = new Map<number, ManagedSession>();
  private readonly store: SessionStore;
  private readonly apiKeyFallback: boolean;
  private readonly sessionApi: SessionApi;
  private readonly providerConfig: ProviderConfigReader;
  private readonly analysis: AnalysisManager;
  private readonly harness: HarnessManager;
  private readonly scorecard: ScorecardManager;

  constructor(
    private readonly config: Config,
    private readonly logger?: Logger,
  ) {
    this.store = new SessionStore(config.paths.sessions, logger);
    this.sessionApi = new SessionApi(logger?.child('session-api'));
    this.providerConfig = new ProviderConfigReader(
      logger?.child('provider-config'),
    );
    this.apiKeyFallback = Boolean(process.env.ANTHROPIC_API_KEY);
    this.analysis = new AnalysisManager({
      config,
      apiKeyFallback: this.apiKeyFallback,
      emit: (event) => this.emit(event),
      ...(logger !== undefined ? { logger: logger.child('analysis') } : {}),
    });
    this.harness = new HarnessManager({
      config,
      apiKeyFallback: this.apiKeyFallback,
      emit: (event) => this.emit(event),
      ...(logger !== undefined ? { logger: logger.child('harness') } : {}),
    });
    this.scorecard = new ScorecardManager({
      config,
      apiKeyFallback: this.apiKeyFallback,
      emit: (event) => this.emit(event),
      ...(logger !== undefined ? { logger: logger.child('scorecard') } : {}),
    });
    // Seed the id counter past the highest persisted id so a restart never
    // reuses an id and clobbers a prior record (the SessionStore collapses by id,
    // last-write-wins). Cold start (no records) ⇒ start at 1, keeping 0 as the
    // "no session" sentinel.
    const records = this.store.list();
    const maxId = records.reduce((max, r) => Math.max(max, r.id), 0);
    this.nextSessionId = createMonotonicCounter(maxId + 1);
  }

  /** Subscribe to the typed engine event stream. Returns an unsubscribe fn. */
  on(listener: (event: NightcoreEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  /** Dispatch a surface command. Start commands spawn a runner; the rest target
   *  an existing session by id (unknown ids are ignored — they may name a
   *  session that already tore down). */
  async dispatch(command: SurfaceCommand): Promise<void> {
    if (command.type === 'start-session') {
      this.startSession(command);
      return;
    }
    // Insight analysis commands are keyed by `runId` (not a session id) and are
    // owned by the AnalysisManager, which fans out its own internal read-only
    // passes and emits the `analysis-*` event family.
    if (command.type === 'start-analysis') {
      this.analysis.start(command);
      return;
    }
    if (command.type === 'cancel-analysis') {
      this.analysis.cancel(command.runId);
      return;
    }
    // Harness convention scans are also keyed by `runId` (not a session id) and are
    // owned by the HarnessManager, which detects the repo profile, fans out its own
    // read-only convention passes + a synthesis pass, and emits the `harness-*`
    // event family.
    if (command.type === 'start-harness-scan') {
      this.harness.start(command);
      return;
    }
    if (command.type === 'cancel-harness-scan') {
      this.harness.cancel(command.runId);
      return;
    }
    // Readiness Scorecard runs are also keyed by `runId` (not a session id) and are
    // owned by the ScorecardManager, which fans out its own read-only grading passes
    // and emits the `scorecard-*` event family.
    if (command.type === 'start-scorecard') {
      this.scorecard.start(command);
      return;
    }
    if (command.type === 'cancel-scorecard') {
      this.scorecard.cancel(command.runId);
      return;
    }

    const session = this.sessions.get(command.sessionId);
    if (!session) {
      this.logger?.debug('command for unknown session dropped', {
        type: command.type,
        sessionId: command.sessionId,
      });
      return;
    }

    switch (command.type) {
      case 'send-input':
        session.runner.streamInput(command.text);
        break;
      case 'interrupt':
        await session.runner.interrupt();
        this.setStatus(session, 'interrupted');
        break;
      case 'set-model':
        await session.runner.setModel(command.model);
        break;
      case 'set-permission-mode':
        await session.runner.setPermissionMode(command.mode);
        break;
      case 'approve-permission':
        session.runner.approvePermission(command.requestId, command.decision);
        break;
      case 'answer-question':
        session.runner.answerQuestion(command.requestId, command.answer);
        break;
    }
  }

  /**
   * Answer a `SurfaceQuery` against the SDK session store, returning the
   * correlated `query-result` event (which the sidecar emits through the same
   * sink). Pure disk reads/writes via the SDK — no session runner involved. The
   * `SessionApi` degrades-not-throws, so a read returns an empty/`ok: true` result
   * rather than rejecting; only a mutation that the SDK reported as failed sets
   * `ok: false`. The SDK return shapes are mapped to the camelCase wire types.
   */
  async handleQuery(
    query: SurfaceQuery,
  ): Promise<NightcoreEventOf<'query-result'>> {
    const { requestId } = query;
    switch (query.type) {
      case 'list-sessions': {
        const sessions = await this.sessionApi.listTaskSessions({
          ...(query.dir !== undefined ? { dir: query.dir } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {}),
          ...(query.offset !== undefined ? { offset: query.offset } : {}),
          ...(query.includeWorktrees !== undefined
            ? { includeWorktrees: query.includeWorktrees }
            : {}),
        });
        return {
          type: 'query-result',
          requestId,
          ok: true,
          kind: 'sessions',
          sessions: sessions.map(toWireSessionInfo),
        };
      }
      case 'get-session-info': {
        const info = await this.sessionApi.getSessionInfoById(
          query.sdkSessionId,
          query.dir !== undefined ? { dir: query.dir } : {},
        );
        return {
          type: 'query-result',
          requestId,
          ok: true,
          kind: 'session-info',
          info: info !== undefined ? toWireSessionInfo(info) : null,
        };
      }
      case 'get-session-messages': {
        const messages = await this.sessionApi.getTaskSessionMessages(
          query.sdkSessionId,
          {
            ...(query.dir !== undefined ? { dir: query.dir } : {}),
            ...(query.limit !== undefined ? { limit: query.limit } : {}),
            ...(query.offset !== undefined ? { offset: query.offset } : {}),
            ...(query.includeSystemMessages !== undefined
              ? { includeSystemMessages: query.includeSystemMessages }
              : {}),
          },
        );
        return {
          type: 'query-result',
          requestId,
          ok: true,
          kind: 'messages',
          messages: messages.map(toWireSessionMessage),
        };
      }
      case 'rename-session': {
        const ok = await this.sessionApi.renameTaskSession(
          query.sdkSessionId,
          query.title,
          query.dir !== undefined ? { dir: query.dir } : {},
        );
        return ok
          ? { type: 'query-result', requestId, ok: true, kind: 'ack' }
          : {
              type: 'query-result',
              requestId,
              ok: false,
              kind: 'ack',
              error: 'rename failed',
            };
      }
      case 'tag-session': {
        const ok = await this.sessionApi.tagTaskSession(
          query.sdkSessionId,
          query.tag,
          query.dir !== undefined ? { dir: query.dir } : {},
        );
        return ok
          ? { type: 'query-result', requestId, ok: true, kind: 'ack' }
          : {
              type: 'query-result',
              requestId,
              ok: false,
              kind: 'ack',
              error: 'tag failed',
            };
      }
      case 'get-provider-config': {
        // The inspector reads RESOLVED, scope-aware config off a transient SDK
        // probe rooted at the project dir (resolution keys off cwd). Reuse a live
        // runner when one exists; else spin the input-less probe runner — the
        // reader shares ONE subprocess and degrades per section, so the snapshot
        // always resolves (`ok: true`).
        const projectPath = query.dir ?? process.cwd();
        const runner = this.firstLiveRunner() ?? this.makeProbeRunner();
        const providerConfig = await this.providerConfig.read(
          runner,
          projectPath,
        );
        return {
          type: 'query-result',
          requestId,
          ok: true,
          kind: 'provider-config',
          providerConfig,
        };
      }
    }
  }

  /** Number of currently-live sessions. */
  get activeCount(): number {
    return this.sessions.size;
  }

  /**
   * List the models the SDK currently offers (dynamic — fetched at runtime, not
   * hardcoded), each with its supported effort levels. Powers the surface's
   * `/model` picker.
   *
   * Reuses a live session's runner when one exists; otherwise spins a transient,
   * input-less runner whose `supportedModels()` probe tears its own query down.
   * Degrades to `[]` on any error (logged at debug) — never throws.
   */
  async listModels(): Promise<ModelDescriptor[]> {
    try {
      const runner = this.firstLiveRunner() ?? this.makeProbeRunner();
      const models = await runner.supportedModels();
      return models.map(toModelDescriptor);
    } catch (error) {
      this.logger?.debug('listModels() failed; returning empty list', error);
      return [];
    }
  }

  /** Any currently-live runner, to piggyback its already-open query. */
  private firstLiveRunner(): SessionRunner | undefined {
    for (const session of this.sessions.values()) return session.runner;
    return undefined;
  }

  /** A runner used only to probe `supportedModels()`. It never runs a session —
   *  `supportedModels()` spins and tears down its own transient query. */
  private makeProbeRunner(): SessionRunner {
    return new SessionRunner(
      {
        sessionId: -1,
        prompt: '',
        model: this.config.model,
        effort: this.config.effort,
        permissionMode: this.config.permissions.mode,
        permissionPolicy: this.config.permissions,
        cwd: process.cwd(),
        apiKeyFallback: this.apiKeyFallback,
        settingSources: this.config.settingSources,
        todoFeatureEnabled: this.config.todoFeatureEnabled,
      },
      () => {},
      this.logger?.child('model-probe'),
    );
  }

  private startSession(
    command: Extract<SurfaceCommand, { type: 'start-session' }>,
  ): number {
    const id = this.nextSessionId();
    const model = command.model ?? this.config.model;
    const effort = command.effort ?? this.config.effort;
    const cwd = command.cwd ?? process.cwd();
    // Autonomy ceilings: a per-task override wins, else the `@nightcore/config`
    // default. `maxTurns` always resolves to a finite guard; `maxBudgetUsd` is
    // uncapped unless the task or config sets it.
    const maxTurns = command.maxTurns ?? this.config.maxTurns;
    const maxBudgetUsd = command.maxBudgetUsd ?? this.config.maxBudgetUsd;
    // Resume: prefer the explicit command id (the recovery path supplies the
    // persisted `sdkSessionId`); a cold start omits it entirely.
    const resumeSessionId = command.resumeSessionId;

    // M4: resolve the task kind to its agent preset (system prompt + tool
    // restrictions + a DEFAULT permission mode). Absent kind ⇒ `build` ⇒ an
    // empty preset, so the session is identical to pre-M4.
    const preset = resolveKindPreset(command.kind);
    // Permission-mode precedence: an explicit command mode wins, then the kind's
    // default, then the configured session default.
    const permissionMode =
      command.permissionMode ??
      preset.permissionMode ??
      this.config.permissions.mode;

    const record: SessionRecord = {
      id,
      prompt: command.prompt,
      model,
      permissionMode,
      cwd,
      status: 'starting',
      createdAt: Date.now(),
    };

    const runner = new SessionRunner(
      {
        sessionId: id,
        prompt: command.prompt,
        model,
        effort,
        permissionMode,
        permissionPolicy: this.config.permissions,
        cwd,
        apiKeyFallback: this.apiKeyFallback,
        settingSources: this.config.settingSources,
        todoFeatureEnabled: this.config.todoFeatureEnabled,
        maxTurns,
        ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
        ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
        // External MCP servers (enabled entries the Rust core resolved + injected on
        // the command). Folded into `Options.mcpServers` by the runner, additively
        // over the user's native config. Absent ⇒ none injected (pre-feature shape).
        ...(command.mcpServers !== undefined
          ? { mcpServers: command.mcpServers }
          : {}),
        ...(preset.appendSystemPrompt !== undefined
          ? { appendSystemPrompt: preset.appendSystemPrompt }
          : {}),
        // Pre-flight Context Pack (Lock, feature #4): the trusted, Nightcore-assembled
        // pack the Rust core passes on the command. The runner composes it BEFORE the
        // preset persona (project rules lead). Absent ⇒ no pack (pre-feature shape).
        ...(command.appendContextPack !== undefined
          ? { appendContextPack: command.appendContextPack }
          : {}),
        ...(preset.allowedTools !== undefined
          ? { allowedTools: preset.allowedTools }
          : {}),
        ...(preset.disallowedTools !== undefined
          ? { disallowedTools: preset.disallowedTools }
          : {}),
      },
      (event) => this.handleEvent(id, event),
      this.logger?.child(`session-${id}`),
    );

    const session: ManagedSession = { id, runner, record };
    this.sessions.set(id, session);
    this.store.save(record);

    this.logger?.info('session started', {
      id,
      model,
      kind: command.kind ?? 'build',
      permissionMode,
    });

    this.emit({
      type: 'session-started',
      sessionId: id,
      prompt: command.prompt,
      model,
      permissionMode,
    });
    this.setStatus(session, 'running');

    // Fire-and-forget: run() never rejects (it converts crashes to events), so a
    // floating promise here is safe and keeps dispatch() non-blocking.
    void runner.run().finally(() => this.retire(id));

    return id;
  }

  /** Intercept a runner event to update bookkeeping, then forward it. A late
   *  event whose session id is no longer live is dropped (monotonic-id guard). */
  private handleEvent(id: number, event: NightcoreEvent): void {
    const session = this.sessions.get(id);
    if (!session) {
      this.logger?.debug('dropping event from retired session', { id });
      return;
    }

    switch (event.type) {
      case 'session-ready':
        session.record.sdkSessionId = event.sdkSessionId;
        break;
      case 'permission-required':
        session.record.status = 'awaiting-permission';
        break;
      case 'session-completed':
        session.record.endedAt = Date.now();
        session.record.costUsd = event.costUsd;
        session.record.status = 'completed';
        this.store.save(session.record);
        this.logger?.info('session completed', {
          id,
          model: session.record.model,
          costUsd: event.costUsd,
          numTurns: event.numTurns,
        });
        break;
      case 'session-failed':
        session.record.endedAt = Date.now();
        session.record.status = 'failed';
        this.store.save(session.record);
        this.logger?.warn('session failed', {
          id,
          model: session.record.model,
          reason: event.reason,
        });
        break;
    }

    this.emit(event);
  }

  private setStatus(session: ManagedSession, status: SessionStatus): void {
    session.record.status = status;
    this.emit({ type: 'session-status', sessionId: session.id, status });
  }

  private retire(id: number): void {
    this.sessions.delete(id);
  }

  private emit(event: NightcoreEvent): void {
    this.emitter.emit('event', event);
  }
}
