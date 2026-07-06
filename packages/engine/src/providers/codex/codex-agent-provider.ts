/**
 * The Codex implementation of the neutral {@link AgentProvider} seam (issue #18,
 * Phase 4 — the second-provider spike).
 *
 * This is a truthful STUB, not a working Codex integration: there is no Codex CLI
 * backend wired. Its whole job is to prove the seam holds for a REAL second provider
 * — that capability degradation fires cleanly with no `match provider` anywhere in
 * orchestration. It does three honest things:
 *
 *  1. advertises the DEGRADED {@link CODEX_CAPABILITIES} descriptor (no hooks / no
 *     MCP / no session store / no AskUserQuestion / no structured output / a reduced
 *     autonomy set / `costTelemetry: 'none'`);
 *  2. enforces the fail-closed hooks invariant in {@link preflight} — an elevated
 *     autonomy (`bypass` / `auto-accept`) on this no-hooks provider is REFUSED unless
 *     an OS sandbox compensates, so confinement is never silently dropped;
 *  3. returns a session that, when driven, emits a clear provider-unavailable
 *     failure rather than pretending to run, and reports every provider-config
 *     section as `unsupported` so the inspector degrades with zero new UI branches.
 *
 * Provider-neutral by construction: it imports NO SDK (the engine SDK-confinement
 * lint confines `@anthropic-ai/claude-agent-sdk` to `providers/claude/**`).
 */
import type {
  AutonomyLevel,
  ModelDescriptor,
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
import { assertHooksInvariant } from '../agent-provider.js';
import {
  CODEX_CAPABILITIES,
  CODEX_PROVIDER_ID,
  CODEX_PROVIDER_LABEL,
} from './capabilities.js';

/** The message every driven Codex session fails with. The spike has no backend, so
 *  a session that clears preflight still cannot run — it degrades honestly instead
 *  of faking output. */
const CODEX_UNAVAILABLE_MESSAGE =
  'The Codex provider is a capability spike (issue #18): no Codex CLI backend is ' +
  'wired, so sessions cannot run. Select the Claude provider to run tasks.';

/** Map the neutral {@link AutonomyLevel} onto the nearest wire `PermissionMode` for
 *  the session record. Codex only ever reaches here with `ask`/`plan` (the elevated
 *  ceilings are refused in preflight before a session is built), so the two safe
 *  ceilings map to their canonical modes and anything else falls back to `default`. */
function autonomyToRecordMode(autonomy: AutonomyLevel): PermissionMode {
  return autonomy === 'plan' ? 'plan' : 'default';
}

/** An `unsupported` provider-config section — the tri-state the inspector renders as
 *  "Not available for this provider". */
const UNSUPPORTED_SECTION: ProviderConfigSection = { status: 'unsupported' };

/**
 * The honest stub session. It never runs a model turn: {@link run} emits a terminal
 * `session-failed` (provider-unavailable) and resolves — the supervisor's
 * degrade-not-throw contract. Every other control is a safe no-op, and
 * {@link probeConfig} returns the fully-`unsupported` snapshot the inspector renders.
 */
class CodexStubSession implements AgentSession {
  readonly permissionMode: PermissionMode;

  constructor(
    private readonly sessionId: number,
    autonomy: AutonomyLevel,
    private readonly emit: SessionEventSink,
    private readonly logger?: Logger,
  ) {
    this.permissionMode = autonomyToRecordMode(autonomy);
  }

  /** Emit the provider-unavailable failure and resolve. Never rejects (the
   *  supervisor converts crashes to events; the stub is failure-only by design). */
  run(): Promise<void> {
    this.logger?.warn('codex session cannot run: provider is a spike stub', {
      sessionId: this.sessionId,
    });
    this.emit({
      type: 'session-failed',
      sessionId: this.sessionId,
      reason: 'unknown',
      message: CODEX_UNAVAILABLE_MESSAGE,
    });
    return Promise.resolve();
  }

  streamInput(): void {
    // No live turn to stream into — the session already failed.
  }

  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  setModel(): Promise<void> {
    return Promise.resolve();
  }

  setAutonomy(): Promise<void> {
    return Promise.resolve();
  }

  approvePermission(): boolean {
    // No parked permission requests: the stub never reaches a tool call.
    return false;
  }

  answerQuestion(): boolean {
    // AskUserQuestion is unsupported (see CODEX_CAPABILITIES) — nothing to answer.
    return false;
  }

  listModels(): Promise<ModelDescriptor[]> {
    // The spike advertises no models; the picker degrades to an empty list.
    return Promise.resolve([]);
  }

  probeConfig(projectPath: string): Promise<ProviderConfigSnapshot> {
    // Every section `unsupported` (a provider DECLINING, distinct from `unavailable`
    // = probe couldn't start). The panel header reads "Codex configuration" and each
    // section reads "Not available for this provider" — zero new UI branches.
    return Promise.resolve({
      providerId: CODEX_PROVIDER_ID,
      providerLabel: CODEX_PROVIDER_LABEL,
      projectPath,
      mcp: UNSUPPORTED_SECTION,
      skills: UNSUPPORTED_SECTION,
      subagents: UNSUPPORTED_SECTION,
      extrasStatus: 'unsupported',
    });
  }
}

/**
 * One Codex provider. Constructed by the engine provider factory when the resolved
 * `config.provider` is `codex`; reused across sessions.
 */
export class CodexAgentProvider implements AgentProvider {
  constructor(private readonly logger?: Logger) {}

  capabilities(): ProviderCapabilities {
    return CODEX_CAPABILITIES;
  }

  /** Fail-closed autonomy guard. Codex reports `supportsHooks: false`, so an elevated
   *  autonomy without an OS sandbox throws {@link AutonomyNotPermittedError} here —
   *  the real second-provider proof that confinement is never silently dropped. */
  preflight(request: PreflightRequest): void {
    assertHooksInvariant(this.capabilities(), request.autonomy, {
      osSandboxed: request.osSandboxed,
    });
  }

  startSession(
    params: StartSessionParams,
    emit: SessionEventSink,
    logger?: Logger,
  ): AgentSession {
    // Codex has no kind presets and no configured default; the effective autonomy is
    // the command override, else `ask` (the safest of its reduced set). The invariant
    // runs BEFORE the session is built: a `bypass`/`auto-accept` override is refused
    // rather than downgraded.
    const autonomy: AutonomyLevel = params.autonomyOverride ?? 'ask';
    this.preflight({
      autonomy,
      osSandboxed: params.sandboxWrites === true,
    });
    return new CodexStubSession(
      params.sessionId,
      autonomy,
      emit,
      logger ?? this.logger,
    );
  }

  createProbeSession(logger?: Logger): AgentSession {
    // Input-less probe (model list / provider-config inspection). It never runs a
    // turn, so its autonomy is the benign `ask`.
    return new CodexStubSession(-1, 'ask', () => {}, logger ?? this.logger);
  }
}
