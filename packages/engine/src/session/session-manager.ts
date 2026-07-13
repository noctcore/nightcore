/**
 * The session supervisor: owns live agent sessions keyed by monotonic id,
 * dispatches surface commands and queries, persists session records, and forwards
 * the typed engine event stream. Delegates the `runId`-keyed scan command families
 * (analysis / harness / scorecard / pr-review) to a {@link ScanRouter} collaborator.
 *
 * Provider-neutral (issue #18/#79): it constructs and drives sessions through the
 * {@link AgentProvider} seam and speaks only `NightcoreEvent` / contract types — no
 * Claude Agent SDK shape reaches this file. Provider selection is delegated to a
 * registry whose factory is the engine-side provider-selection point; the supervisor
 * forwards the command's `providerId` without branching on provider behavior.
 */
import { EventEmitter } from 'node:events';

import type {
  Config,
  ModelDescriptor,
  NightcoreEvent,
  NightcoreEventOf,
  SessionRecord,
  SessionStatus,
  SurfaceCommand,
  SurfaceQuery,
} from '@nightcore/contracts';
import { createMonotonicCounter, type Logger } from '@nightcore/shared';
import { SessionStore } from '@nightcore/storage';

import { CouncilRouter } from '../debate/council-router.js';
import type {
  AgentProvider,
  AgentSession,
} from '../providers/agent-provider.js';
import {
  AutonomyNotPermittedError,
  GovernanceNotSupportedError,
} from '../providers/agent-provider.js';
import { SessionApi } from '../providers/claude/session-api.js';
import {
  buildProviderRegistry,
  type ProviderRegistry,
} from '../providers/provider-factory.js';
import { ScanRouter } from '../scans/scan-router.js';
import { probeModels } from './session-models.js';
import { handleSessionQuery } from './session-query.js';
import { resolveStartSessionParams } from './session-start-params.js';

interface ManagedSession {
  id: number;
  runner: AgentSession;
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
  private readonly providers: ProviderRegistry;
  private readonly scans: ScanRouter;
  private readonly council: CouncilRouter;

  constructor(
    private readonly config: Config,
    private readonly logger?: Logger,
    /** Agent providers that construct + drive sessions. Injectable so the
     *  fail-closed gate-battery test can swap them; defaults to the config-driven
     *  registry factory (the sole provider-selection point). */
    providers?: AgentProvider | ProviderRegistry,
  ) {
    this.store = new SessionStore(config.paths.sessions, logger);
    this.sessionApi = new SessionApi(logger?.child('session-api'));
    this.apiKeyFallback = Boolean(process.env.ANTHROPIC_API_KEY);
    this.providers =
      providers === undefined
        ? buildProviderRegistry(config, { apiKeyFallback: this.apiKeyFallback }, logger)
        : 'forSession' in providers
          ? providers
          : {
              forSession: () => providers,
              all: () => [providers],
            };
    // Scan orchestration is a separate concern: the router owns the four scan
    // managers and their dispatch, emitting through this supervisor's event sink.
    this.scans = new ScanRouter({
      config,
      apiKeyFallback: this.apiKeyFallback,
      emit: (event) => this.emit(event),
      providers: this.providers,
      ...(logger !== undefined ? { logger } : {}),
    });
    // The Council conductor drives its seats as one-shot sessions through this
    // supervisor (issue #350), routed by a sibling collaborator like the scans.
    this.council = new CouncilRouter({
      startSession: (command) => this.startSession(command),
      subscribe: (listener) => this.on(listener),
      logger,
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

    // The Council command family (issue #350) is `runId`-keyed, not session-id-keyed,
    // like the scans — route it to the Conductor before the `command.sessionId` lookup.
    if (this.council.handles(command)) {
      this.council.dispatch(command);
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
      case 'set-autonomy':
        // The wire command carries the neutral autonomy vocabulary; the session
        // control bridges it to the provider's own primitive (for Claude, an SDK
        // permission-mode control request) inside the provider.
        await session.runner.setAutonomy(command.autonomy);
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

  /** Answer a `SurfaceQuery` against the SDK session store — delegates to {@link
   *  handleSessionQuery} (extracted for the file-size ratchet; behavior verbatim),
   *  threading in exactly the collaborators this supervisor already owns. */
  async handleQuery(
    query: SurfaceQuery,
  ): Promise<NightcoreEventOf<'query-result'>> {
    return handleSessionQuery(
      {
        sessionApi: this.sessionApi,
        providers: this.providers,
        listModels: () => this.listModels(),
        firstLiveRunner: () => this.firstLiveRunner(),
        makeProbeSession: (providerId) => this.makeProbeSession(providerId),
        ...(this.logger !== undefined ? { logger: this.logger } : {}),
      },
      query,
    );
  }

  /** Number of currently-live sessions. */
  get activeCount(): number {
    return this.sessions.size;
  }

  /** List the models every configured provider offers, each with its supported effort
   *  levels — powers the surface's `/model` picker. Delegates to {@link probeModels}
   *  (extracted for the file-size ratchet; behavior verbatim). Never throws. */
  async listModels(): Promise<ModelDescriptor[]> {
    return probeModels(this.providers, this.logger);
  }

  /** Any currently-live session, to piggyback its already-open query. */
  private firstLiveRunner(): AgentSession | undefined {
    for (const session of this.sessions.values()) return session.runner;
    return undefined;
  }

  /** A transient probe session (model list / provider-config inspection). It never
   *  runs a turn — the provider's probe spins and tears down its own query. */
  private makeProbeSession(providerId?: string): AgentSession {
    return this.providers
      .forSession(providerId)
      .createProbeSession(this.logger?.child('model-probe'));
  }

  private startSession(
    command: Extract<SurfaceCommand, { type: 'start-session' }>,
  ): number {
    const id = this.nextSessionId();
    const provider = this.providers.forSession(command.providerId);
    // Neutral start params (extracted to `resolveStartSessionParams` for the
    // file-size ratchet; behavior verbatim).
    const params = resolveStartSessionParams(id, command, this.config);

    // Construct the run through the provider seam. The fail-closed hooks invariant
    // AND the fail-closed governance invariant (issue #296) both run inside
    // `startSession`: a provider that can't enforce PreToolUse confinement at the
    // requested autonomy, or can't enforce an ARMED Harness policy, REFUSES here
    // rather than silently dropping confinement or governance. Surface the refusal
    // as a terminal `session-failed` so the board shows it like any other failure
    // and the concurrency slot is never taken.
    let runner: AgentSession;
    try {
      runner = provider.startSession(
        params,
        (event) => this.handleEvent(id, event),
        this.logger?.child(`session-${id}`),
      );
    } catch (error) {
      if (error instanceof AutonomyNotPermittedError) {
        return this.refuseSession(id, error.message, 'autonomy not permitted', {
          providerId: error.providerId,
          autonomy: error.autonomy,
        });
      }
      if (error instanceof GovernanceNotSupportedError) {
        return this.refuseSession(id, error.message, 'governance not supported', {
          providerId: error.providerId,
        });
      }
      throw error;
    }

    // The provider resolved the effective autonomy (override / kind preset /
    // configured default); read it back for the persisted record + the
    // `session-started` event.
    const permissionMode = runner.permissionMode;
    const record: SessionRecord = {
      id,
      prompt: command.prompt,
      model: params.model,
      permissionMode,
      cwd: params.cwd,
      status: 'starting',
      createdAt: Date.now(),
    };

    const session: ManagedSession = { id, runner, record };
    this.sessions.set(id, session);
    this.store.save(record);

    this.logger?.info('session started', {
      id,
      model: params.model,
      kind: command.kind ?? 'build',
      permissionMode,
    });

    this.emit({
      type: 'session-started',
      sessionId: id,
      prompt: command.prompt,
      model: params.model,
      permissionMode,
    });
    this.setStatus(session, 'running');

    // Fire-and-forget: run() never rejects (it converts crashes to events), so a
    // floating promise here is safe and keeps dispatch() non-blocking.
    void runner.run().finally(() => this.retire(id));

    return id;
  }

  /** Log + emit `session-failed` for a preflight-refused run (autonomy or
   *  governance) — no runner started, so unlike a crash no slot was taken. */
  private refuseSession(
    id: number,
    message: string,
    reason: string,
    logContext: Record<string, unknown>,
  ): number {
    this.logger?.warn(`session refused: ${reason}`, { id, ...logContext });
    this.emit({ type: 'session-failed', sessionId: id, reason: 'runner-crash', message });
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
        if (event.costUsd !== undefined) {
          session.record.costUsd = event.costUsd;
        }
        session.record.status = 'completed';
        this.store.save(session.record);
        this.logger?.info('session completed', {
          id,
          model: session.record.model,
          costUsd: event.costUsd ?? null,
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
