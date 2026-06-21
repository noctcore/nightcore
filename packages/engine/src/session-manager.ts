import { EventEmitter } from 'node:events';
import type {
  Config,
  ModelDescriptor,
  NightcoreEvent,
  SessionRecord,
  SessionStatus,
  SurfaceCommand,
} from '@nightcore/contracts';
import { SessionStore } from '@nightcore/storage';
import { createMonotonicCounter, type Logger } from '@nightcore/shared';
import { SessionRunner } from './session-runner.js';
import { resolveKindPreset } from './kind-presets.js';
import type { ModelInfo } from './sdk-adapter.js';

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
  private readonly nextSessionId = createMonotonicCounter();
  private readonly sessions = new Map<number, ManagedSession>();
  private readonly store: SessionStore;
  private readonly apiKeyFallback: boolean;

  constructor(
    private readonly config: Config,
    private readonly logger?: Logger,
  ) {
    this.store = new SessionStore(config.paths.sessions, logger);
    this.apiKeyFallback = Boolean(process.env.ANTHROPIC_API_KEY);
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
        ...(preset.appendSystemPrompt !== undefined
          ? { appendSystemPrompt: preset.appendSystemPrompt }
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
        break;
      case 'session-failed':
        session.record.endedAt = Date.now();
        session.record.status = 'failed';
        this.store.save(session.record);
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
