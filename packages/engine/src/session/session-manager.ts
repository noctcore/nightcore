/**
 * The session supervisor: owns live `SessionRunner`s keyed by monotonic id,
 * dispatches surface commands and queries, persists session records, and forwards
 * the typed engine event stream. Delegates the `runId`-keyed scan command families
 * (analysis / harness / scorecard / pr-review) to a {@link ScanRouter} collaborator,
 * and exposes SDK→wire mappers.
 */
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
import { createMonotonicCounter, type Logger } from '@nightcore/shared';
import { SessionStore } from '@nightcore/storage';

import { ProviderConfigReader } from '../providers/provider-config.js';
import { ScanRouter } from '../scans/scan-router.js';
import { resolveKindPreset } from './kind-presets.js';
import type { ModelInfo } from './sdk-adapter.js';
import { type SDKSessionInfo, SessionApi, type SessionMessage } from './session-api.js';
import { SessionRunner } from './session-runner.js';

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
 * event, never a rejected promise. Supports N concurrent sessions and a rich
 * typed event stream.
 *
 * Runners are in-process: the SDK already spawns its own CLI subprocess per
 * session, so an extra worker_thread per session would be redundant
 * double-subprocessing.
 */
export class SessionManager {
  private readonly emitter = new EventEmitter();
  private readonly nextSessionId: () => number;
  private readonly sessions = new Map<number, ManagedSession>();
  private readonly store: SessionStore;
  private readonly apiKeyFallback: boolean;
  private readonly sessionApi: SessionApi;
  private readonly providerConfig: ProviderConfigReader;
  private readonly scans: ScanRouter;

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
    // Scan orchestration is a separate concern: the router owns the four scan
    // managers and their dispatch, emitting through this supervisor's event sink.
    this.scans = new ScanRouter({
      config,
      apiKeyFallback: this.apiKeyFallback,
      emit: (event) => this.emit(event),
      ...(logger !== undefined ? { logger } : {}),
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
    // The `runId`-keyed scan command families (analysis / harness / scorecard /
    // pr-review / issue-validation) belong to the ScanRouter; it owns the dedicated
    // managers, each of which runs its own read-only session(s) and emits its
    // `<family>-*` events. Issue-triage validation is a single-pass member of this
    // set (slice 2/5 wired its engine manager into the router), so narrowing it here
    // keeps it out of the `command.sessionId` lookup below (it carries a `runId`, not
    // a `sessionId`).
    if (this.scans.handles(command)) {
      this.scans.dispatch(command);
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
        if (!session.runner.approvePermission(command.requestId, command.decision))
          this.logger?.warn('stale or unknown permission request dropped', {
            requestId: command.requestId,
            sessionId: command.sessionId,
          });
        break;
      case 'answer-question':
        if (!session.runner.answerQuestion(command.requestId, command.answer))
          this.logger?.warn('stale or unknown question request dropped', {
            requestId: command.requestId,
            sessionId: command.sessionId,
          });
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

    // Resolve the task kind to its agent preset (system prompt + tool
    // restrictions + a DEFAULT permission mode). Absent kind ⇒ `build` ⇒ an
    // empty preset, so the session keeps its default behavior.
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
        images: command.images,
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
        // The raw task kind, threaded so the runner can post-process a `decompose`
        // session's final result into structured `proposedSubtasks` on the
        // `session-completed` event (mirrors the Insight findings pipeline). The
        // PERSONA still comes from the resolved preset below; this is only the
        // result-parse selector. Absent ⇒ no per-kind result post-processing.
        ...(command.kind !== undefined ? { kind: command.kind } : {}),
        ...(preset.appendSystemPrompt !== undefined
          ? { appendSystemPrompt: preset.appendSystemPrompt }
          : {}),
        // Pre-flight context pack: the trusted, Nightcore-assembled pack the Rust
        // core passes on the command. The runner composes it BEFORE the
        // preset persona (project rules lead). Absent ⇒ no pack (pre-feature shape).
        ...(command.appendContextPack !== undefined
          ? { appendContextPack: command.appendContextPack }
          : {}),
        // Harness runtime policy (module #3): the manifest-declared protected
        // paths + Bash deny patterns the Rust core resolved for this project.
        // Enforced by the runner's PreToolUse gate (holds under bypass). Absent ⇒
        // no policy layer (pre-feature shape).
        ...(command.harnessPolicy !== undefined
          ? { harnessPolicy: command.harnessPolicy }
          : {}),
        // Session flight recorder (module #5): the per-task ledger path the Rust
        // core computed from the project root. The runner appends every
        // PreToolUse gate evaluation there. Absent ⇒ no recording (pre-feature
        // shape).
        ...(command.ledgerPath !== undefined
          ? { ledgerPath: command.ledgerPath }
          : {}),
        // OPT-IN macOS OS write containment (module #15): requested by the Rust
        // core from the `sandbox_sessions` setting. The runner wraps the CLI in
        // a Seatbelt deny-write-except profile when the host supports it (and
        // warns loudly + runs unwrapped when it doesn't). Absent ⇒ off.
        ...(command.sandboxWrites !== undefined
          ? { sandboxWrites: command.sandboxWrites }
          : {}),
        ...(preset.allowedTools !== undefined
          ? { allowedTools: preset.allowedTools }
          : {}),
        ...(preset.disallowedTools !== undefined
          ? { disallowedTools: preset.disallowedTools }
          : {}),
        // SDK-native structured output (`decompose` preset): forwarded so the
        // runner sets `Options.outputFormat` and the SDK returns a schema-conforming
        // `{ subtasks }` object (retrying non-conforming output itself). Absent ⇒ a
        // free-form text result (every other kind).
        ...(preset.outputFormat !== undefined
          ? { outputFormat: preset.outputFormat }
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
