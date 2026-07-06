/**
 * The Claude implementation of the neutral {@link AgentProvider} seam (issue #18).
 *
 * Owns everything Claude-specific behind the boundary: it resolves the task-kind
 * preset (persona + tool restrictions + structured-output format + a default
 * permission mode), assembles the SDK-facing {@link SessionRunnerConfig}, constructs
 * a {@link SessionRunner} (which implements {@link AgentSession}), advertises the
 * {@link CLAUDE_CAPABILITIES} descriptor, and bridges the wire `PermissionMode`
 * vocabulary to the neutral autonomy vocabulary for the fail-closed hooks invariant.
 *
 * The supervisor never sees any of this — it hands over neutral
 * {@link StartSessionParams} and drives the returned `AgentSession`.
 */
import type { Config, ProviderCapabilities } from '@nightcore/contracts';
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
  autonomyToPermissionMode,
  CLAUDE_CAPABILITIES,
  permissionModeToAutonomy,
} from './capabilities.js';
import { resolveKindPreset } from './kind-presets.js';
import type { SessionRunnerConfig } from './session-options.js';
import { SessionRunner } from './session-runner.js';

export class ClaudeAgentProvider implements AgentProvider {
  constructor(
    private readonly config: Config,
    private readonly opts: { apiKeyFallback: boolean },
    private readonly logger?: Logger,
  ) {}

  capabilities(): ProviderCapabilities {
    return CLAUDE_CAPABILITIES;
  }

  /** Fail-closed autonomy guard. Claude reports `supportsHooks: true`, so this never
   *  throws today — the PreToolUse confinement is always enforceable — but the check
   *  runs the real path so a future degraded provider is caught at the same seam. */
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
    // Resolve the task kind to its agent preset (system prompt + tool restrictions +
    // a DEFAULT permission mode). Absent kind ⇒ `build` ⇒ an empty preset.
    const preset = resolveKindPreset(params.kind);
    // Autonomy precedence: an explicit command override (neutral vocabulary, lowered
    // to the SDK mode HERE at the provider boundary) wins, then the kind's default,
    // then the provider's configured session default (both already SDK modes).
    const permissionMode =
      (params.autonomyOverride !== undefined
        ? autonomyToPermissionMode(params.autonomyOverride)
        : undefined) ??
      preset.permissionMode ??
      this.config.permissions.mode;

    // Fail-closed hooks invariant BEFORE the runner is built: an elevated autonomy on
    // a provider that can't enforce the PreToolUse gate is refused, never silently
    // downgraded. Claude passes; a degraded provider throws AutonomyNotPermittedError.
    // The invariant is evaluated in neutral terms (the resolved SDK mode → autonomy).
    this.preflight({
      autonomy: permissionModeToAutonomy(permissionMode),
      osSandboxed: params.sandboxWrites === true,
    });

    const cfg: SessionRunnerConfig = {
      sessionId: params.sessionId,
      prompt: params.prompt,
      ...(params.images !== undefined ? { images: params.images } : {}),
      model: params.model,
      ...(params.effort !== undefined ? { effort: params.effort } : {}),
      permissionMode,
      permissionPolicy: this.config.permissions,
      cwd: params.cwd,
      apiKeyFallback: this.opts.apiKeyFallback,
      settingSources: this.config.settingSources,
      todoFeatureEnabled: this.config.todoFeatureEnabled,
      ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
      ...(params.maxBudgetUsd !== undefined
        ? { maxBudgetUsd: params.maxBudgetUsd }
        : {}),
      ...(params.resumeSessionId !== undefined
        ? { resumeSessionId: params.resumeSessionId }
        : {}),
      // External MCP servers (enabled entries the Rust core resolved). Folded into
      // Options.mcpServers additively over the user's native config.
      ...(params.mcpServers !== undefined
        ? { mcpServers: params.mcpServers }
        : {}),
      // The raw task kind, threaded so a `decompose` run's final result is parsed
      // into structured `proposedSubtasks` on `session-completed`.
      ...(params.kind !== undefined ? { kind: params.kind } : {}),
      ...(preset.appendSystemPrompt !== undefined
        ? { appendSystemPrompt: preset.appendSystemPrompt }
        : {}),
      // Pre-flight context pack: composed BEFORE the preset persona (project rules
      // lead). Absent ⇒ no pack.
      ...(params.appendContextPack !== undefined
        ? { appendContextPack: params.appendContextPack }
        : {}),
      // Harness runtime policy (protected paths + Bash deny patterns), enforced by
      // the runner's PreToolUse gate (holds under bypass).
      ...(params.harnessPolicy !== undefined
        ? { harnessPolicy: params.harnessPolicy }
        : {}),
      // Session flight-recorder ledger path; the runner appends every gate decision.
      ...(params.ledgerPath !== undefined
        ? { ledgerPath: params.ledgerPath }
        : {}),
      // OPT-IN macOS OS write containment (Seatbelt), the compensating control the
      // hooks invariant accepts.
      ...(params.sandboxWrites !== undefined
        ? { sandboxWrites: params.sandboxWrites }
        : {}),
      ...(preset.allowedTools !== undefined
        ? { allowedTools: preset.allowedTools }
        : {}),
      ...(preset.disallowedTools !== undefined
        ? { disallowedTools: preset.disallowedTools }
        : {}),
      // SDK-native structured output (`decompose` preset).
      ...(preset.outputFormat !== undefined
        ? { outputFormat: preset.outputFormat }
        : {}),
    };

    return new SessionRunner(cfg, emit, logger ?? this.logger);
  }

  /** A transient, input-less probe session used only for `listModels()` /
   *  `probeConfig()` — it never runs a model turn. Mirrors the config the supervisor
   *  used to build inline for the model probe. */
  createProbeSession(logger?: Logger): AgentSession {
    return new SessionRunner(
      {
        sessionId: -1,
        prompt: '',
        model: this.config.model,
        effort: this.config.effort,
        permissionMode: this.config.permissions.mode,
        permissionPolicy: this.config.permissions,
        cwd: process.cwd(),
        apiKeyFallback: this.opts.apiKeyFallback,
        settingSources: this.config.settingSources,
        todoFeatureEnabled: this.config.todoFeatureEnabled,
      },
      () => {},
      logger ?? this.logger,
    );
  }
}
