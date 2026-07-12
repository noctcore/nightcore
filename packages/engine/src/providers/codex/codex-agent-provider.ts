import type {
  AutonomyLevel,
  ModelDescriptor,
  NightcoreEvent,
  PermissionMode,
  ProviderCapabilities,
  ProviderConfigSection,
  ProviderConfigSnapshot,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import type {
  AgentProvider,
  AgentSession,
  PreflightRequest,
  SessionEventSink,
  StartSessionParams,
} from '../agent-provider.js';
import {
  assertGovernanceInvariant,
  assertHooksInvariant,
  AutonomyNotPermittedError,
} from '../agent-provider.js';
import { DECOMPOSE_OUTPUT_FORMAT } from '../claude/decompose.js';
import { resolveKindPreset } from '../claude/kind-presets.js';
import {
  CODEX_CAPABILITIES,
  CODEX_PROVIDER_ID,
  CODEX_PROVIDER_LABEL,
} from './capabilities.js';
import { buildCodexFirstTurnInput } from './codex-images.js';
import { listCodexModels, probeCodexCli } from './model-catalog.js';
import {
  buildCodexOptions,
  buildCodexThreadOptions,
  codexBypassOptedIn,
  codexEffectiveAutonomy,
  codexPostureForAutonomy,
} from './options.js';
import {
  checkCodexBinaryOverride,
  resolveCodexBinaryOverride,
} from './resolve-codex-binary.js';
import {
  type CodexFactory,
  createCodexTranslationState,
  defaultCodexFactory,
  type Input,
  type ThreadEvent,
  translateCodexEvent,
  type TurnOptions,
} from './sdk-adapter.js';

// The minimal Codex SDK surface a session drives, and its production factory over
// the real `@openai/codex-sdk` client — both defined in `sdk-adapter.ts` (the SDK
// boundary module) and re-exported here for `CodexAgentProvider`'s test fakes.
export type { CodexFactory, CodexLike, CodexThreadLike } from './sdk-adapter.js';

/**
 * Default idle watchdog deadline for a Codex turn: 30 minutes with NO stream event
 * resets the timer on every yield. Mirrors the Claude runner's
 * `DEFAULT_IDLE_TIMEOUT_MS` — deliberately generous so one long tool call (a
 * multi-minute build) that emits no `ThreadEvent`s isn't killed, while a genuinely
 * wedged `codex exec` (stopped yielding, no terminal `turn.completed`/`turn.failed`)
 * is reaped instead of hanging the run and leaking its concurrency slot forever.
 * Injectable via the provider/session constructor for tests only.
 */
export const CODEX_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Sentinel returned by {@link CodexSession.nextWithIdleDeadline} when the idle
 *  watchdog fires before the turn's event stream yields its next event. */
const CODEX_IDLE_STALLED = Symbol('codex-idle-stalled');

function autonomyToRecordMode(autonomy: AutonomyLevel): PermissionMode {
  switch (autonomy) {
    case 'bypass':
      return 'bypassPermissions';
    case 'auto-accept':
      return 'acceptEdits';
    case 'plan':
      return 'plan';
    case 'ask':
      return 'default';
  }
}

const SUPPORTED_EMPTY_SECTION: ProviderConfigSection = { status: 'supported' };

class CodexSession implements AgentSession {
  readonly permissionMode: PermissionMode;
  private readonly abort = new AbortController();
  /** Mid-run user messages buffered by {@link streamInput}, drained one-per-turn as
   *  follow-up turns (a Codex turn is a one-shot `codex exec`, so a message can't be
   *  injected into the running turn — only delivered as the next one). */
  private readonly followUps: string[] = [];

  constructor(
    private readonly params: StartSessionParams,
    private readonly autonomy: AutonomyLevel,
    private readonly emit: SessionEventSink,
    private readonly logger?: Logger,
    private readonly codexFactory: CodexFactory = defaultCodexFactory,
    /** Idle watchdog deadline (ms) for each turn's event stream — see
     *  {@link CODEX_IDLE_TIMEOUT_MS}. Overridable only so tests can trip the stall
     *  path without waiting 30 minutes. */
    private readonly idleTimeoutMs: number = CODEX_IDLE_TIMEOUT_MS,
  ) {
    this.permissionMode = autonomyToRecordMode(autonomy);
  }

  async run(): Promise<void> {
    const codexPathOverride = resolveCodexBinaryOverride();
    const overrideWarning = checkCodexBinaryOverride(codexPathOverride);
    if (overrideWarning !== undefined) {
      this.fail('runner-crash', overrideWarning);
      return;
    }

    // Cleanup for the first-turn image temp files (set only when the run had images).
    let cleanupImages: (() => void) | undefined;
    try {
      const posture = codexPostureForAutonomy(this.autonomy, {
        bypassOptedIn: codexBypassOptedIn(),
      });
      const preset = resolveKindPreset(this.params.kind);
      const codex = this.codexFactory(
        buildCodexOptions({
          ...(codexPathOverride !== undefined ? { codexPathOverride } : {}),
          ...(this.params.mcpServers !== undefined
            ? { mcpServers: this.params.mcpServers }
            : {}),
        }),
      );
      const threadOptions = buildCodexThreadOptions({
        model: this.params.model,
        ...(this.params.effort !== undefined
          ? { effort: this.params.effort }
          : {}),
        cwd: this.params.cwd,
        posture,
      });
      const thread =
        this.params.resumeSessionId !== undefined
          ? codex.resumeThread(this.params.resumeSessionId, threadOptions)
          : codex.startThread(threadOptions);
      const turnOptions: TurnOptions = {
        signal: this.abort.signal,
        ...(this.params.kind === 'decompose'
          ? { outputSchema: DECOMPOSE_OUTPUT_FORMAT.schema }
          : {}),
      };
      const state = createCodexTranslationState({
        sessionId: this.params.sessionId,
        model: this.params.model,
        ...(this.params.kind !== undefined ? { kind: this.params.kind } : {}),
      });

      // First turn = context pack + persona + prompt PLUS any image attachments; each
      // follow-up turn carries only the user's new message (the resumed thread retains
      // the prior context). Its image temp files are removed in the `finally`.
      const firstTurn = buildCodexFirstTurnInput(this.params, preset.appendSystemPrompt);
      cleanupImages = firstTurn.cleanup;
      let input: Input = firstTurn.input;

      // A Codex turn is a one-shot `codex exec`, so a mid-run follow-up can only be
      // delivered as the NEXT turn (the SDK resumes the thread by id when
      // `thread.runStreamed` is called again). Loop turns: when a turn COMPLETES,
      // deliver a buffered follow-up as another turn instead of finalizing. Only the
      // final turn (nothing queued) emits the held `session-completed` — an
      // intermediate one must not, or the supervisor would retire the run early.
      for (;;) {
        const streamed = await thread.runStreamed(input, turnOptions);
        const held = await this.drainTurnEvents(streamed.events, state);
        if (held === CODEX_IDLE_STALLED) {
          // A wedged `codex exec` that stopped yielding without a terminal event
          // would otherwise hang this loop forever, leaking the run's concurrency
          // slot. Abort the turn (cancels the subprocess via the shared signal) and
          // report a terminal runner crash — the same fail-visible posture as the
          // Claude runner's idle watchdog (never a silent hang).
          this.abort.abort();
          this.fail(
            'runner-crash',
            `Codex stream stalled (no output for ${Math.round(
              this.idleTimeoutMs / 60000,
            )} min) and was reaped.`,
          );
          return;
        }
        if (held === undefined) {
          this.fail('runner-crash', 'Codex stream ended without a terminal event.');
          return;
        }
        // A failed turn is terminal — surface it and stop (no follow-up continuation).
        if (held.some((event) => event.type === 'session-failed')) {
          for (const next of held) this.emit(next);
          return;
        }
        // A completed turn: deliver a buffered follow-up as the next turn, else emit
        // the held completion and finish.
        const followUp = this.followUps.shift();
        if (followUp === undefined) {
          for (const next of held) this.emit(next);
          return;
        }
        input = followUp;
      }
    } catch (error) {
      if (this.abort.signal.aborted) {
        this.fail('aborted', 'Codex session interrupted.');
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn('codex session failed', { message });
      this.fail('runner-crash', message);
    } finally {
      // Remove the first-turn image temp files on EVERY exit (completion, failure, or
      // interrupt). No-op when the run had no images.
      cleanupImages?.();
    }
  }

  /**
   * Drive one turn's event stream to its terminal event under an idle deadline.
   * Returns the held terminal events when the turn completes/fails in time,
   * `undefined` when the stream ends with no terminal event, or
   * {@link CODEX_IDLE_STALLED} when the watchdog fires first (a wedged subprocess).
   * Non-terminal events are emitted as they arrive, exactly like the prior
   * `for await` loop — the only change is the per-`next()` idle race.
   */
  private async drainTurnEvents(
    events: AsyncIterable<ThreadEvent>,
    state: ReturnType<typeof createCodexTranslationState>,
  ): Promise<NightcoreEvent[] | undefined | typeof CODEX_IDLE_STALLED> {
    const iterator = events[Symbol.asyncIterator]();
    for (;;) {
      const next = await this.nextWithIdleDeadline(iterator);
      if (next === CODEX_IDLE_STALLED) return CODEX_IDLE_STALLED;
      if (next.done === true) return undefined;
      const translated = translateCodexEvent(next.value, state);
      if (translated.terminal) return translated.events;
      for (const event of translated.events) this.emit(event);
    }
  }

  /**
   * Await the stream's next event under an idle deadline. Returns the
   * `IteratorResult` when the turn yields (or ends) in time, or
   * {@link CODEX_IDLE_STALLED} when {@link idleTimeoutMs} elapses first. A fresh
   * timer per call, so every yielded event resets it — only a genuinely quiet
   * (wedged) stream trips it. When the timer wins, the dangling `next()` promise's
   * eventual rejection (from the turn abort) is swallowed so it never surfaces as an
   * unhandled rejection. Mirrors the Claude runner's `nextWithIdleDeadline`.
   */
  private async nextWithIdleDeadline(
    iterator: AsyncIterator<ThreadEvent>,
  ): Promise<IteratorResult<ThreadEvent> | typeof CODEX_IDLE_STALLED> {
    const nextPromise = iterator.next();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<typeof CODEX_IDLE_STALLED>((resolve) => {
      timer = setTimeout(() => resolve(CODEX_IDLE_STALLED), this.idleTimeoutMs);
    });
    try {
      const result = await Promise.race([nextPromise, idle]);
      if (result === CODEX_IDLE_STALLED) {
        void Promise.resolve(nextPromise).catch(() => {});
      }
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  streamInput(text: string): void {
    // A Codex turn is a one-shot `codex exec` (stdin is closed after the prompt), so a
    // mid-run message can't be injected into the running turn. Buffer it; `run()`
    // delivers it as a follow-up turn (resuming the thread) once the current turn
    // completes, instead of dropping it. Empty input is ignored; a message that
    // arrives after the run finished is inert (the session has already retired).
    if (text.length === 0) return;
    this.followUps.push(text);
  }

  async interrupt(): Promise<void> {
    this.abort.abort();
  }

  async setModel(): Promise<void> {
    // Applies to the next session; Codex has no live setModel control.
  }

  async setAutonomy(): Promise<void> {
    // Applies to the next session; Codex has no live setAutonomy control.
  }

  approvePermission(): boolean {
    return false;
  }

  answerQuestion(): boolean {
    return false;
  }

  listModels(): Promise<ModelDescriptor[]> {
    return listCodexModels(this.logger);
  }

  probeConfig(projectPath: string): Promise<ProviderConfigSnapshot> {
    // Validate the codex CLI prerequisite AT SELECTION (issue #144 / D10), mirroring
    // the claude-not-found fail-fast: the read-only inspector is where the user learns
    // Codex is installed & signed in, instead of discovering it via a confusing
    // mid-run crash. A missing CLI surfaces as `unavailable` sections carrying an
    // actionable message (the inspector renders those with a Retry), never a false
    // all-green snapshot that lies about a provider that can't run.
    const base = {
      providerId: CODEX_PROVIDER_ID,
      providerLabel: CODEX_PROVIDER_LABEL,
      projectPath,
      subagents: { status: 'unsupported' } as const,
    };
    const status = probeCodexCli();
    if (!status.ok) {
      const unavailable: ProviderConfigSection = {
        status: 'unavailable',
        error: status.message ?? 'Codex CLI unavailable',
      };
      return Promise.resolve({
        ...base,
        mcp: unavailable,
        skills: unavailable,
        extrasStatus: 'unavailable',
      });
    }
    return Promise.resolve({
      ...base,
      mcp: SUPPORTED_EMPTY_SECTION,
      skills: SUPPORTED_EMPTY_SECTION,
      extrasStatus: 'supported',
    });
  }

  private fail(
    reason: Extract<
      Parameters<SessionEventSink>[0],
      { type: 'session-failed' }
    >['reason'],
    message: string,
  ): void {
    this.emit({
      type: 'session-failed',
      sessionId: this.params.sessionId,
      reason,
      message,
    });
  }
}

export class CodexAgentProvider implements AgentProvider {
  constructor(
    private readonly logger?: Logger,
    /** Injectable Codex SDK client factory — production uses the real
     *  `@openai/codex-sdk`; tests fake the turn loop with no `codex exec` spawn. */
    private readonly codexFactory: CodexFactory = defaultCodexFactory,
    /** Idle watchdog deadline (ms) threaded into every session — see
     *  {@link CODEX_IDLE_TIMEOUT_MS}. Overridable for tests only. */
    private readonly idleTimeoutMs: number = CODEX_IDLE_TIMEOUT_MS,
  ) {}

  capabilities(): ProviderCapabilities {
    return CODEX_CAPABILITIES;
  }

  preflight(request: PreflightRequest): void {
    assertHooksInvariant(this.capabilities(), request.autonomy, {
      osSandboxed: request.osSandboxed,
      ...(request.uncontainedBypassOptIn !== undefined
        ? { uncontainedBypassOptIn: request.uncontainedBypassOptIn }
        : {}),
    });
  }

  startSession(
    params: StartSessionParams,
    emit: SessionEventSink,
    logger?: Logger,
  ): AgentSession {
    // Fail-closed governance preflight (issue #296) BEFORE anything else: Codex has
    // no PreToolUse-equivalent seam, so a run whose Harness policy is ARMED
    // (present and non-empty) is REFUSED here rather than silently running
    // ungoverned. Never trips on a project's always-on ledger path — see
    // `assertGovernanceInvariant`'s docblock. A real interception point exists one
    // layer below the `@openai/codex-sdk` this session drives (`codex app-server`'s
    // `execCommandApproval`/`applyPatchApproval` RPCs — see
    // `CODEX_CAPABILITIES`'s docblock) but wiring it is a separate, larger
    // initiative tracked as #304; this refusal is the durable answer until then.
    assertGovernanceInvariant(this.capabilities(), params);

    // Resolve the EFFECTIVE ceiling: a read-only KIND (the reviewer/verify identity
    // OR the decompose proposer) is pinned to `plan` — the read-only sandbox — no
    // matter the resolved autonomy, so such a run is provably unable to mutate the
    // repo (Codex has no `disallowedTools` wiring, so the KIND's read-only-ness must
    // be enforced by the kernel sandbox, not a tool denylist). Every other kind
    // defaults the undefined-autonomy path to the safe read-only `plan` (`ask` would
    // deadlock).
    const autonomy: AutonomyLevel = codexEffectiveAutonomy(
      params.autonomyOverride,
      params.kind,
    );
    const posture = codexPostureForAutonomy(autonomy, {
      bypassOptedIn: codexBypassOptedIn(),
    });
    this.preflight({
      autonomy,
      osSandboxed: posture.contained && autonomy !== 'bypass',
      ...(autonomy === 'bypass'
        ? { uncontainedBypassOptIn: codexBypassOptedIn() }
        : {}),
    });
    if (autonomy === 'bypass' && !codexBypassOptedIn()) {
      throw new AutonomyNotPermittedError(CODEX_PROVIDER_ID, autonomy);
    }
    return new CodexSession(
      params,
      autonomy,
      emit,
      logger ?? this.logger,
      this.codexFactory,
      this.idleTimeoutMs,
    );
  }

  createProbeSession(logger?: Logger): AgentSession {
    return new CodexSession(
      {
        sessionId: -1,
        prompt: '',
        model: 'codex',
        cwd: process.cwd(),
      },
      // A probe never runs a turn, so its ceiling is inert — use the safe read-only
      // `plan` for consistency with the non-deadlocking default.
      'plan',
      () => {},
      logger ?? this.logger,
      this.codexFactory,
      this.idleTimeoutMs,
    );
  }
}
