/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { type Config, ConfigSchema, type NightcoreEvent } from '@nightcore/contracts';

import type { CodexFactory, CodexThreadLike } from '../../providers/codex/codex-agent-provider.js';
import { CodexAgentProvider } from '../../providers/codex/codex-agent-provider.js';
import type { ThreadEvent } from '../../providers/codex/sdk-adapter.js';
import type { ProviderRegistry } from '../../providers/provider-factory.js';
import type {
  ActiveScanRun,
  BaseScanCommand,
  ScanManagerDeps,
  SessionConfigParts,
} from './scan-manager.js';
import { runScanSession } from './session-spin.js';

const BASE_CONFIG: Config = ConfigSchema.parse({
  paths: { home: '/tmp/nc-home', sessions: '/tmp/nc-home/sessions' },
});

/** A scripted Codex thread that streams one turn and completes with `resultText`
 *  as the agent's final message — enough for `runScanSession` to reach a terminal
 *  `session-completed`, no real `codex exec` subprocess involved. */
function scriptedThread(resultText: string): CodexThreadLike {
  return {
    runStreamed() {
      async function* events(): AsyncGenerator<ThreadEvent> {
        yield { type: 'thread.started', thread_id: 'thread-scan' };
        yield { type: 'turn.started' };
        yield {
          type: 'item.completed',
          item: { id: 'msg-1', type: 'agent_message', text: resultText },
        };
        yield {
          type: 'turn.completed',
          usage: {
            input_tokens: 5,
            cached_input_tokens: 0,
            output_tokens: 2,
            reasoning_output_tokens: 0,
          },
        };
      }
      return Promise.resolve({ events: events() });
    },
  };
}

/** A minimal `ProviderRegistry` whose `codex` entry is a REAL `CodexAgentProvider`
 *  (not a stub) — the fake only sits at the codex-sdk boundary (`CodexFactory`), so
 *  every line of `CodexAgentProvider.startSession` (the autonomy resolution +
 *  refusal check that this regression guards) actually executes. */
function realCodexRegistry(resultText: string): ProviderRegistry {
  const factory: CodexFactory = () => {
    const thread = scriptedThread(resultText);
    return { startThread: () => thread, resumeThread: () => thread };
  };
  const provider = new CodexAgentProvider(undefined, factory);
  return {
    forSession: () => provider,
    all: () => [provider],
  };
}

function activeRun(runId: string): ActiveScanRun {
  return { runId, runners: new Set(), cancelled: false };
}

const SCAN_PARTS: SessionConfigParts = {
  appendSystemPrompt: 'You are a read-only convention auditor.',
  allowedTools: [],
  disallowedTools: [],
  maxTurns: 5,
};

describe('runScanSession — Codex autonomy regression (#295)', () => {
  test('a scan session against a REAL CodexAgentProvider is created without throwing', async () => {
    // Regression guard for #295: the scan path used to hardcode
    // `autonomyOverride: 'bypass'`, which `CodexAgentProvider.startSession` refuses
    // unconditionally (`AutonomyNotPermittedError`) without the
    // `NIGHTCORE_CODEX_ALLOW_BYPASS` opt-in — so every Insight/Harness/PR-review/
    // Scorecard run under a Codex model failed on the very first pass. Unlike the
    // stubbed provider in `harness/manager.test.ts`, this test drives the REAL
    // `CodexAgentProvider.startSession`, so it actually exercises the refusal check
    // that the old hardcoded value tripped.
    const events: NightcoreEvent[] = [];
    const deps: ScanManagerDeps = {
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit: (e) => events.push(e),
      providers: realCodexRegistry('[]'),
    };
    const command: BaseScanCommand = {
      runId: 'run-codex-scan',
      projectPath: '/proj',
      providerId: 'codex',
      model: 'gpt-5-codex',
    };

    const outcomePromise = runScanSession(
      deps,
      command,
      'Audit this repo for naming conventions.',
      activeRun('run-codex-scan'),
      SCAN_PARTS,
      'test-pass',
    );

    await expect(outcomePromise).resolves.toBeDefined();
    const outcome = await outcomePromise;

    // The old `'bypass'` request threw `AutonomyNotPermittedError` synchronously
    // inside `provider.startSession`, before a session was ever constructed — this
    // asserts the fixed request is accepted and the pass reaches a real terminal
    // result instead.
    expect(outcome.error).toBeUndefined();
    expect(outcome.reason).toBeUndefined();
    expect(outcome.result).toBe('[]');
  });

  test('the requested autonomy resolves to the read-only `plan` posture, not the refused `bypass`', async () => {
    // Direct assertion on the posture Codex actually resolves for a scan pass with
    // no `kind` set (scans never pass one): confirms the fix maps onto Codex's
    // kernel-enforced read-only sandbox, matching the scans' read-only intent.
    const provider = new CodexAgentProvider(undefined, () => {
      const thread = scriptedThread('[]');
      return { startThread: () => thread, resumeThread: () => thread };
    });

    expect(() =>
      provider.startSession(
        {
          sessionId: -1,
          prompt: 'read-only scan pass',
          model: 'gpt-5-codex',
          cwd: '/proj',
          autonomyOverride: 'plan',
        },
        () => {},
      ),
    ).not.toThrow();
  });
});
