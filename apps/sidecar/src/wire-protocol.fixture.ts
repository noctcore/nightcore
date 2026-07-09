#!/usr/bin/env bun
/**
 * Deterministic mock-sidecar fixture for the wire-protocol integration test.
 *
 * The live sidecar (`index.ts` → `main()`) wires the real `SessionManager`, which
 * drives the Claude Agent SDK — that needs subscription auth, spends real money,
 * and is nondeterministic, so it can NOT run as a per-PR CI gate. But the protocol
 * plumbing that carries the NDJSON wire contract (`createSidecar`, `pumpCommands`,
 * `encodeEvent`, `CommandLineBuffer`, and the inbound `SurfaceCommandSchema` /
 * outbound `NightcoreEventSchema` validation) is the SAME code the live entry uses.
 *
 * This fixture spawns exactly that plumbing against real stdio — but hands it a
 * hand-scripted `ScriptedManager` in place of `SessionManager`, so no Claude
 * session is ever created. `wire-protocol.integration.test.ts` drives this as a
 * child process over real OS pipes and asserts the live serialize → transport →
 * deserialize round-trip: a happy-path `start-session` exchange, the `max-turns`
 * terminal path, a `list-sessions` request/reply, and stream resilience to a bad
 * line. That closes the gap the manual `scripts/headless-harness.ts` dogfood probe
 * used to be the only guard for.
 *
 * It is deliberately NOT imported by `index.ts`, so the `bun build --compile` step
 * (which bundles only the `index.ts` import graph) never ships it in the binary.
 * `import.meta.main` guards the live wiring: importing this file is inert.
 */
import {
  type NightcoreEvent,
  type NightcoreEventOf,
  type SurfaceCommand,
  type SurfaceQuery,
} from '@nightcore/contracts';

import { createSidecar, pumpCommands, type SidecarManager } from './index.js';

/**
 * A scripted stand-in for `SessionManager`. It emits faithful, schema-valid
 * `NightcoreEvent` sequences in response to the `SurfaceCommand`s the sidecar
 * dispatches — no SDK, no auth, no cost, fully deterministic. Session ids are
 * monotonic from 1, mirroring the real manager so the driver reads the id off the
 * `session-started` echo exactly as the Rust core does.
 */
class ScriptedManager implements SidecarManager {
  private listener: ((event: NightcoreEvent) => void) | null = null;
  private nextSessionId = 1;

  on(listener: (event: NightcoreEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  private emit(event: NightcoreEvent): void {
    this.listener?.(event);
  }

   
  async dispatch(command: SurfaceCommand): Promise<void> {
    if (command.type !== 'start-session') {
      // Every other command (interrupt, set-model, approve-permission, …) is a
      // no-op for the wire round-trip: the driver only needs the framed inbound
      // parse to succeed, which the sidecar already did before calling dispatch.
      return;
    }

    const sessionId = this.nextSessionId++;
    const model = command.model ?? 'claude-sonnet-4-6';
    // The wire command now carries the neutral `autonomy` vocabulary; the
    // `session-started` event still reports the resolved SDK permission mode, and
    // this scripted harness doesn't run a real provider, so it reports the studio's
    // default unattended mode. (The `autonomy` override, if any, is otherwise a
    // no-op for this fixture's round-trip.)
    const permissionMode = 'bypassPermissions';

    this.emit({ type: 'session-started', sessionId, prompt: command.prompt, model, permissionMode });

    // A tiny turn ceiling trips the guardrail — the same signal the real
    // `headless-harness.ts` Scenario 2 uses to force `session-failed`.
    if (command.maxTurns !== undefined && command.maxTurns <= 1) {
      this.emit({
        type: 'session-failed',
        sessionId,
        reason: 'max-turns',
        message: 'reached the maximum number of turns (fixture guardrail)',
      });
      return;
    }

    // Happy path: the representative lifecycle a build session streams.
    this.emit({
      type: 'session-ready',
      sessionId,
      sdkSessionId: `sdk-fixture-${sessionId}`,
      model,
      tools: ['Read', 'Write', 'Bash'],
      slashCommands: [],
      skills: [],
    });
    this.emit({ type: 'assistant-delta', sessionId, text: 'Working on it… ', partial: true });
    this.emit({
      type: 'tool-use-requested',
      sessionId,
      toolUseId: `tool-${sessionId}-1`,
      toolName: 'Write',
      input: { file_path: 'NIGHTCORE_HELLO.md', content: 'hello from the wire-protocol fixture' },
    });
    this.emit({
      type: 'tool-result',
      sessionId,
      toolUseId: `tool-${sessionId}-1`,
      isError: false,
      content: 'File written.',
    });
    this.emit({
      type: 'session-completed',
      sessionId,
      result: 'Created NIGHTCORE_HELLO.md.',
      costUsd: 0,
      numTurns: 2,
      durationMs: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningOutputTokens: 0,
      },
    });
  }

   
  async handleQuery(query: SurfaceQuery): Promise<NightcoreEventOf<'query-result'>> {
    if (query.type === 'list-sessions') {
      return {
        type: 'query-result',
        requestId: query.requestId,
        ok: true,
        kind: 'sessions',
        sessions: [
          {
            sdkSessionId: 'sdk-fixture-1',
            summary: 'fixture session',
            lastModified: 0,
          },
        ],
      };
    }
    // A bare success for the other read/mutate queries (rename/tag/etc.).
    return { type: 'query-result', requestId: query.requestId, ok: true, kind: 'ack' };
  }
}

/** Live wiring — identical shape to `index.ts`'s `main()`, minus the real manager
 *  and config. Guarded so importing this module has no side effects. */
async function main(): Promise<void> {
  const { handleLine } = createSidecar(
    new ScriptedManager(),
    (line) => {
      process.stdout.write(line);
    },
    (message) => {
      process.stderr.write(`${message}\n`);
    },
  );
  process.stderr.write('nightcore-sidecar-fixture ready\n');
  await pumpCommands(Bun.stdin.stream(), handleLine);
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    process.stderr.write(`fixture fatal: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
