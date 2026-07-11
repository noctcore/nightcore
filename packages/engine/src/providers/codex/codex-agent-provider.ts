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
import {
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
import { listCodexModels } from './model-catalog.js';
import {
  buildCodexOptions,
  buildCodexThreadOptions,
  codexBypassOptedIn,
  codexPostureForAutonomy,
} from './options.js';
import {
  checkCodexBinaryOverride,
  resolveCodexBinaryOverride,
} from './resolve-codex-binary.js';
import {
  Codex,
  createCodexTranslationState,
  translateCodexEvent,
  type TurnOptions,
} from './sdk-adapter.js';

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

  constructor(
    private readonly params: StartSessionParams,
    private readonly autonomy: AutonomyLevel,
    private readonly emit: SessionEventSink,
    private readonly logger?: Logger,
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

    try {
      const posture = codexPostureForAutonomy(this.autonomy, {
        bypassOptedIn: codexBypassOptedIn(),
      });
      const preset = resolveKindPreset(this.params.kind);
      const codex = new Codex(
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
      const input = [
        this.params.appendContextPack,
        preset.appendSystemPrompt,
        this.params.prompt,
      ]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join('\n\n');
      const streamed = await thread.runStreamed(input, turnOptions);
      const state = createCodexTranslationState({
        sessionId: this.params.sessionId,
        model: this.params.model,
        ...(this.params.kind !== undefined ? { kind: this.params.kind } : {}),
      });
      for await (const event of streamed.events) {
        const translated = translateCodexEvent(event, state);
        for (const next of translated.events) this.emit(next);
        if (translated.terminal) return;
      }
      this.fail('runner-crash', 'Codex stream ended without a terminal event.');
    } catch (error) {
      if (this.abort.signal.aborted) {
        this.fail('aborted', 'Codex session interrupted.');
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn('codex session failed', { message });
      this.fail('runner-crash', message);
    }
  }

  streamInput(): void {
    // Codex SDK turns are one-shot; follow-up turn streaming is not wired yet.
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
    return Promise.resolve({
      providerId: CODEX_PROVIDER_ID,
      providerLabel: CODEX_PROVIDER_LABEL,
      projectPath,
      mcp: SUPPORTED_EMPTY_SECTION,
      skills: SUPPORTED_EMPTY_SECTION,
      subagents: { status: 'unsupported' },
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
  constructor(private readonly logger?: Logger) {}

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
    // Default to the safe read-only `plan` when no autonomy was resolved: `ask` is
    // no longer a supported Codex ceiling (no approval channel — it would deadlock),
    // so it can't be the fallback. In practice the Rust settings resolver always
    // sends an explicit autonomy; this default only guards the undefined path.
    const autonomy: AutonomyLevel = params.autonomyOverride ?? 'plan';
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
    return new CodexSession(params, autonomy, emit, logger ?? this.logger);
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
    );
  }
}
