#!/usr/bin/env bun
/**
 * Nightcore Claude provider sidecar.
 *
 * There is no Rust Claude Agent SDK, so the agent loop runs here — in Bun — and
 * the Rust/Tauri core drives it as a child process over a line-delimited (NDJSON)
 * stdio protocol:
 *
 *   stdin   ← one JSON `SurfaceCommand` per line  (start-session, send-input,
 *             approve-permission, interrupt, set-model, set-permission-mode)
 *   stdout  → one JSON `NightcoreEvent` per line   (session lifecycle, assistant
 *             deltas, tool use, permission requests, completion)
 *   stderr  → human-readable logs only (never part of the protocol)
 *
 * This is deliberately thin: it forwards parsed commands straight into the
 * existing `SessionManager` and streams every emitted event back out. All the
 * orchestration intelligence (the auto-loop, concurrency, worktrees, dependency
 * ordering) lives in the Rust core, NOT here. Swapping in a different provider
 * later means writing another sidecar that speaks this same protocol.
 */
import { resolveConfig } from '@nightcore/config';
import { SessionManager } from '@nightcore/engine';
import { createLogger } from '@nightcore/shared';
import type { NightcoreEvent, SurfaceCommand } from '@nightcore/contracts';

function emit(event: NightcoreEvent): void {
  // One compact JSON object per line. The Rust core splits on '\n'.
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main(): Promise<void> {
  const config = resolveConfig();
  const logger = createLogger(config.logLevel, 'sidecar');
  const manager = new SessionManager(config, logger);

  manager.on((event) => {
    emit(event);
    // M0: interactive approval isn't wired through the UI yet, so auto-deny any
    // permission request rather than hang. (M1 forwards the decision back in
    // over stdin as an `approve-permission` command.)
    if (event.type === 'permission-required') {
      void manager.dispatch({
        type: 'approve-permission',
        sessionId: event.sessionId,
        requestId: event.requestId,
        decision: {
          behavior: 'deny',
          message: 'M0 sidecar: interactive approval not wired yet.',
        },
      });
    }
  });

  process.stderr.write('nightcore-sidecar ready\n');

  // Parse NDJSON commands off stdin. Bun streams raw bytes; we buffer and split
  // on newlines so a command split across chunks still parses.
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line.length === 0) continue;

      let command: SurfaceCommand;
      try {
        command = JSON.parse(line) as SurfaceCommand;
      } catch (error) {
        process.stderr.write(`sidecar: bad command json: ${String(error)}\n`);
        continue;
      }
      void manager.dispatch(command);
    }
  }
}

void main();
