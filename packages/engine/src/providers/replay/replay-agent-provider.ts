/**
 * The replay agent provider — E2E ladder rings 2–3 (issue #406).
 *
 * A real {@link AgentProvider} behind the same neutral seam Claude and Codex sit
 * behind, whose "model" is a checked-in transcript. It exists so the ladder's upper
 * rings can drive the REAL process boundaries — the real Bun sidecar over its real
 * NDJSON protocol (ring 3), and the real built Tauri app over WebDriver (ring 2) —
 * without a provider credential, a network, or a cent of spend, and with a
 * bit-for-bit reproducible event stream.
 *
 * ## Why the provider seam and not a mock layer
 *
 * The whole point of the ring is that everything BETWEEN the transcript and the
 * assertion is production code: `SessionManager` supervision + id assignment, the
 * sidecar's outbound `NightcoreEventSchema` validation and NDJSON framing, the Rust
 * reader's FIFO correlation, the store writes, the web's transcript rendering. A
 * parallel mock injected further up would skip exactly the code the ring is meant to
 * exercise. This is a provider, so it swaps in at the one seam that was built for it.
 *
 * ## Registration is opt-in and fail-loud
 *
 * `buildProviderRegistry` registers this provider ONLY when `NIGHTCORE_E2E_REPLAY`
 * names a readable directory of transcripts, and when it does, that directory is
 * validated eagerly. A production build never sets the variable, so it can never
 * resolve here; a misspelt path fails at construction instead of yielding an engine
 * that silently pretends to run agents.
 */
import type {
  AutonomyLevel,
  ModelDescriptor,
  NightcoreEvent,
  PermissionMode,
  ProviderConfigSnapshot,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import type {
  AgentProvider,
  AgentSession,
  SessionEventSink,
  StartSessionParams,
} from '../agent-provider.js';
// The neutral AutonomyLevel → wire PermissionMode map. It lives in `providers/claude/`
// because Claude owns the inverse direction too, but the function itself touches only
// contract vocabulary (no SDK type), so reusing it here keeps ONE home for the mapping
// rather than a second copy that could drift.
import { autonomyToPermissionMode } from '../claude/capabilities.js';
import { REPLAY_CAPABILITIES, REPLAY_PROVIDER_ID } from './capabilities.js';
import { loadTranscript, restampSessionId, transcriptNameFor } from './transcript.js';

/**
 * Milliseconds between replayed events. `0` (the default) replays the transcript as
 * fast as the event loop allows — what ring 3 wants, since it asserts the STREAM, not
 * its timing. Ring 2 sets a small pace so the app's UI has a chance to paint the
 * intermediate states a human would see. A fixed integer either way: never a random
 * or load-dependent delay, so the ring stays deterministic.
 */
function pacingMs(): number {
  const raw = Number.parseInt(process.env.NIGHTCORE_E2E_REPLAY_PACE_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** The deterministic model catalog the replay provider advertises. Fixed data: the
 *  ladder's model picker assertions must not depend on a live provider's catalog. */
const REPLAY_MODELS: ModelDescriptor[] = [
  {
    providerId: REPLAY_PROVIDER_ID,
    value: 'replay-fixture',
    displayName: 'Replay fixture',
    description: 'Replays a checked-in transcript. Deterministic, offline, free.',
    supportsEffort: false,
    supportedEffortLevels: [],
  },
];

/** One replayed run. Owns no resource beyond a timer, so `interrupt()` is exact. */
class ReplaySession implements AgentSession {
  readonly permissionMode: PermissionMode;
  /** Set by {@link interrupt}; checked between events so an abort lands on the next
   *  boundary rather than mid-stream. */
  private aborted = false;
  /** Guards the terminal event: a run that already emitted its recorded terminal must
   *  not also emit an abort terminal (two terminals would double-release the Rust
   *  slot — the exact class `e2e::slot_leak` guards). */
  private settled = false;

  constructor(
    private readonly params: StartSessionParams,
    private readonly transcriptDir: string,
    private readonly emit: SessionEventSink,
    private readonly logger?: Logger,
  ) {
    this.permissionMode = autonomyToPermissionMode(
      this.params.autonomyOverride ?? 'bypass',
    );
  }

  async run(): Promise<void> {
    const name = transcriptNameFor({
      prompt: this.params.prompt,
      kind: this.params.kind,
    });
    let events: NightcoreEvent[];
    try {
      events = loadTranscript(this.transcriptDir, name);
    } catch (error) {
      // Degrade-not-throw, like every other provider: a bad transcript surfaces as a
      // terminal failure the surface can render, not a rejected promise. It is still
      // LOUD — the message names the file — so the ring fails with a diagnosis.
      this.settle({
        type: 'session-failed',
        sessionId: this.params.sessionId,
        reason: 'runner-crash',
        message: `replay provider: ${String(error)}`,
      });
      return;
    }

    this.logger?.info('replaying transcript', {
      transcript: name,
      events: events.length,
    });

    const pace = pacingMs();
    for (const event of events) {
      if (this.aborted) break;
      if (pace > 0) await new Promise<void>((resolve) => setTimeout(resolve, pace));
      if (this.aborted) break;
      const stamped = restampSessionId(event, this.params.sessionId);
      if (stamped.type === 'session-completed' || stamped.type === 'session-failed') {
        this.settle(stamped);
        return;
      }
      this.emit(stamped);
    }

    // Only reachable when an interrupt cut the stream short — the transcript's own
    // terminal returns above, and a transcript with no terminal is rejected at load.
    this.settle({
      type: 'session-failed',
      sessionId: this.params.sessionId,
      reason: 'aborted',
      message: 'replay interrupted',
    });
  }

  /** Emit the run's ONE terminal event, at most once. */
  private settle(event: NightcoreEvent): void {
    if (this.settled) return;
    this.settled = true;
    this.emit(event);
  }

  streamInput(text: string): void {
    // A transcript is a fixed recording — extra input cannot change it. Logged rather
    // than silently swallowed so a ring that sends input and expects a reaction can
    // see why nothing happened.
    this.logger?.debug('replay session ignoring streamed input', {
      chars: text.length,
    });
  }

  interrupt(): Promise<void> {
    this.aborted = true;
    return Promise.resolve();
  }

  setModel(model: string): Promise<void> {
    this.logger?.debug('replay session ignoring setModel', { model });
    return Promise.resolve();
  }

  setAutonomy(autonomy: AutonomyLevel): Promise<void> {
    this.logger?.debug('replay session ignoring setAutonomy', { autonomy });
    return Promise.resolve();
  }

  /** No tool call ever reaches a permission gate here, so nothing is ever parked and
   *  a decision can never match a pending request. `false` is the honest answer (the
   *  same one a live session gives for an unknown request id). Declared without
   *  parameters — structurally compatible with the seam, and there is no argument
   *  this implementation could meaningfully read. */
  approvePermission(): boolean {
    return false;
  }

  answerQuestion(): boolean {
    return false;
  }

  listModels(): Promise<ModelDescriptor[]> {
    return Promise.resolve(REPLAY_MODELS);
  }

  probeConfig(projectPath: string): Promise<ProviderConfigSnapshot> {
    return Promise.resolve({
      providerId: REPLAY_CAPABILITIES.id,
      providerLabel: REPLAY_CAPABILITIES.label,
      projectPath,
      // `unsupported`, not `unavailable`: nothing FAILED to read — this provider has
      // no MCP/skill/subagent surface at all, and the tri-state distinguishes the two.
      mcp: { status: 'unsupported' },
      skills: { status: 'unsupported' },
      subagents: { status: 'unsupported' },
      extrasStatus: 'unsupported',
    });
  }
}

/** The replay provider. Constructed once per sidecar process by the factory. */
export class ReplayAgentProvider implements AgentProvider {
  constructor(
    private readonly transcriptDir: string,
    private readonly logger?: Logger,
  ) {}

  capabilities() {
    return REPLAY_CAPABILITIES;
  }

  /**
   * Deliberately a NO-OP, and this is the one provider where that is correct rather
   * than a dropped guarantee.
   *
   * {@link assertHooksInvariant} refuses an elevated autonomy on a `supportsHooks:
   * false` provider because the PreToolUse gate is the ONLY thing standing between the
   * agent and the filesystem. Here there is no agent and no tool call: `run()` emits
   * pre-recorded events and returns. There is nothing to confine, so applying the
   * invariant would refuse every ladder run for a risk that cannot exist — and the two
   * dishonest ways to make it pass (declaring `supportsHooks: true`, or passing a fake
   * `osSandboxed: true`) would put a LIE in the capability descriptor that the UI and
   * orchestration both degrade from. An explicit, argued no-op is the honest form.
   *
   * The safety of this rests entirely on the provider being unreachable in production:
   * it is registered only under `NIGHTCORE_E2E_REPLAY` (see `provider-factory.ts`).
   */
  preflight(): void {}

  startSession(
    params: StartSessionParams,
    emit: SessionEventSink,
    logger?: Logger,
  ): AgentSession {
    return new ReplaySession(
      params,
      this.transcriptDir,
      emit,
      logger ?? this.logger,
    );
  }

  createProbeSession(logger?: Logger): AgentSession {
    // A probe is only ever asked for listModels()/probeConfig(); the params are inert
    // placeholders that no code path reads (`run()` is never driven on a probe).
    return new ReplaySession(
      { sessionId: -1, prompt: '', model: 'replay-fixture', cwd: process.cwd() },
      this.transcriptDir,
      () => {},
      logger ?? this.logger,
    );
  }
}
