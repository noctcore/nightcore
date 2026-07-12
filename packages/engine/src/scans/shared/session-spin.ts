/**
 * Spin ONE read-only provider session for a scan pass and capture its terminal
 * result/usage — the Claude-direct vs Codex-provider construction fork. Extracted
 * from {@link ScanManager} (so the orchestrator stays pure and under its file-size
 * ratchet) with its behavior preserved verbatim: the runner's own events are consumed
 * locally (heartbeat throttled) and never forwarded to the main stream — only the
 * feature's `*-*` events do. Shared by every scan family via {@link ScanManager.runOneSession}.
 */
import type { TokenUsage } from '@nightcore/contracts';

import { makeHeartbeat } from './observability.js';
import {
  type ActiveScanRun,
  type BaseScanCommand,
  defaultRunnerFactory,
  type ScanManagerDeps,
  type ScanSessionRunner,
  type SessionConfigParts,
  type SessionFailedReason,
  type SessionOutcome,
} from './scan-manager.js';
import { EMPTY_USAGE } from './usage.js';

/**
 * Run one read-only session for `prompt` and return its terminal outcome. `parts` is
 * the feature's resolved per-pass config (persona + toolset + ceilings, from
 * `sessionConfig`); `heartbeatLabel` is its throttled-progress tag (from
 * `heartbeatLabel`). The Claude path (or a test `runnerFactory` override) wires the
 * exact allowed/disallowed tools directly; the Codex path routes through the provider
 * registry, composing the system instructions into the prompt.
 */
export async function runScanSession(
  deps: ScanManagerDeps,
  command: BaseScanCommand,
  prompt: string,
  run: ActiveScanRun,
  parts: SessionConfigParts,
  heartbeatLabel: string,
): Promise<SessionOutcome> {
  let result: string | undefined;
  let structuredOutput: Record<string, unknown> | undefined;
  let usage: TokenUsage = { ...EMPTY_USAGE };
  let costUsd = 0;
  let error: string | undefined;
  let reason: SessionFailedReason | undefined;
  // Throttled progress so a long pass shows life in the terminal instead of
  // running silent until it completes (the sub-session's events never hit the wire).
  const heartbeat = makeHeartbeat(deps.logger, heartbeatLabel);

  const effort = command.effort ?? deps.config.effort;
  const providerId = command.providerId ?? deps.config.provider;
  const hasProviders = !!deps.providers;
  const isCodexProvider = providerId === 'codex' && hasProviders;

  let runner: ScanSessionRunner;

  if (deps.runnerFactory || !isCodexProvider) {
    // Claude path (or test runnerFactory override): use the direct config that
    // wires appendSystemPrompt + exact allowed/disallowed tools into the runner.
    const factory = deps.runnerFactory ?? defaultRunnerFactory;
    runner = factory(
      {
        sessionId: -1,
        prompt,
        model: command.model ?? deps.config.model,
        ...(effort ? { effort } : {}),
        permissionMode: 'dontAsk',
        permissionPolicy: deps.config.permissions,
        cwd: command.projectPath,
        apiKeyFallback: deps.apiKeyFallback,
        settingSources: deps.config.settingSources,
        todoFeatureEnabled: false,
        appendSystemPrompt: parts.appendSystemPrompt,
        allowedTools: parts.allowedTools,
        disallowedTools: parts.disallowedTools,
        maxTurns: parts.maxTurns,
        ...(parts.maxBudgetUsd !== undefined
          ? { maxBudgetUsd: parts.maxBudgetUsd }
          : {}),
        ...(parts.outputFormat !== undefined
          ? { outputFormat: parts.outputFormat }
          : {}),
      },
      (event) => {
        if (event.type === 'session-completed') {
          result = event.result;
          structuredOutput = event.structuredOutput;
          costUsd = event.costUsd ?? 0;
          if (event.usage !== undefined) usage = event.usage;
        } else if (event.type === 'session-failed') {
          error = event.message;
          reason = event.reason;
        } else {
          heartbeat(event);
        }
      },
      deps.logger?.child(heartbeatLabel),
    );
  } else {
    // Codex (or other future providers): route through the provider so it can
    // use its own SDK / structured output support. We compose the system
    // instructions into the prompt.
    const providers = deps.providers!;
    const provider = providers.forSession(providerId);
    const fullPrompt = [parts.appendSystemPrompt, prompt].filter(Boolean).join('\n\n');
    const session = provider.startSession(
      {
        sessionId: -1,
        prompt: fullPrompt,
        model: command.model ?? deps.config.model,
        ...(effort ? { effort } : {}),
        cwd: command.projectPath,
        // Scans are read-only analysis: request the neutral `plan` ceiling, which
        // maps to Codex's kernel-enforced read-only sandbox (`codexPostureForAutonomy`)
        // and is actually in Codex's advertised `autonomyLevels`. `bypass` is NOT
        // advertised for Codex and is unconditionally refused without the
        // `NIGHTCORE_CODEX_ALLOW_BYPASS` process opt-in (`assertHooksInvariant`),
        // so requesting it here made every scan fail on pass #1 under Codex. The
        // Claude scan path never reads this field at all — it goes through
        // `SessionRunner` directly with `permissionMode: 'dontAsk'` above, so this
        // change is Codex-only.
        autonomyOverride: 'plan',
        maxTurns: parts.maxTurns,
        ...(parts.maxBudgetUsd !== undefined
          ? { maxBudgetUsd: parts.maxBudgetUsd }
          : {}),
      },
      (event) => {
        if (event.type === 'session-completed') {
          result = event.result;
          structuredOutput = event.structuredOutput;
          costUsd = event.costUsd ?? 0;
          if (event.usage !== undefined) usage = event.usage;
        } else if (event.type === 'session-failed') {
          error = event.message;
          reason = event.reason;
        } else {
          heartbeat(event);
        }
      },
      deps.logger?.child(heartbeatLabel),
    );
    runner = {
      run: () => session.run(),
      interrupt: () =>
        (session as { interrupt?: () => Promise<void> }).interrupt?.() ??
        Promise.resolve(),
    };
  }

  run.runners.add(runner);
  try {
    await runner.run();
  } finally {
    run.runners.delete(runner);
  }
  return {
    result,
    usage,
    costUsd,
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}
