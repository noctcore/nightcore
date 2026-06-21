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
 *
 * The protocol plumbing (event sink, command framing, manager wiring) is factored
 * into small, injectable units so it can be unit-tested with a stub manager — no
 * live Claude session, no token use, no cost. The live entrypoint at the bottom
 * (`import.meta.main`) wires the real `SessionManager` to real stdio.
 */
import { resolveConfig } from '@nightcore/config';
import { SessionManager } from '@nightcore/engine';
import { createLogger } from '@nightcore/shared';
import type { NightcoreEvent, SurfaceCommand } from '@nightcore/contracts';

/** Emits one already-framed `NightcoreEvent` line to the wire. The live sink
 *  writes to stdout; tests inject a collector to assert framing. */
export type EventSink = (line: string) => void;

/** The minimal slice of `SessionManager` the sidecar drives. Declaring it as an
 *  interface lets tests pass a stub so no live Claude session is ever created. */
export interface SidecarManager {
  on(listener: (event: NightcoreEvent) => void): () => void;
  dispatch(command: SurfaceCommand): Promise<void>;
}

/** Serialize one `NightcoreEvent` to its NDJSON wire form (exactly one line). */
export function encodeEvent(event: NightcoreEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Buffers raw stdin bytes and yields complete NDJSON command lines. A command
 * split across chunks still parses: bytes accumulate until a newline closes a
 * line. Blank lines are skipped. Decoded with a streaming `TextDecoder` so a
 * multibyte char split across a chunk boundary is not corrupted.
 */
export class CommandLineBuffer {
  private readonly decoder = new TextDecoder();
  private buffer = '';

  /** Feed a chunk; return every complete, non-blank line it completes. */
  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }
}

/**
 * Wire a manager to an event sink and return a command handler.
 *
 * - Every event the manager emits is encoded and pushed to `sink` (one line).
 * - Permission requests are auto-denied: interactive approval isn't wired through
 *   the UI yet, so we answer rather than hang. The Rust core mirrors this for
 *   defence in depth; either denial is harmless (the runner ignores a second).
 * - The returned `handleLine` parses one NDJSON command and dispatches it,
 *   logging (never throwing) on malformed JSON so one bad line can't kill the
 *   stream.
 */
export function createSidecar(
  manager: SidecarManager,
  sink: EventSink,
  onError: (message: string) => void = (m) => process.stderr.write(`${m}\n`),
): { handleLine: (line: string) => void } {
  manager.on((event) => {
    sink(encodeEvent(event));
    if (event.type === 'permission-required') {
      void manager.dispatch({
        type: 'approve-permission',
        sessionId: event.sessionId,
        requestId: event.requestId,
        decision: {
          behavior: 'deny',
          message: 'sidecar: interactive approval not wired yet.',
        },
      });
    }
  });

  function handleLine(line: string): void {
    let command: SurfaceCommand;
    try {
      command = JSON.parse(line) as SurfaceCommand;
    } catch (error) {
      onError(`sidecar: bad command json: ${String(error)}`);
      return;
    }
    void manager.dispatch(command);
  }

  return { handleLine };
}

/** Drive the sidecar from an async byte stream (stdin), framing NDJSON commands
 *  through `CommandLineBuffer` and handing each completed line to `handleLine`. */
export async function pumpCommands(
  stream: AsyncIterable<Uint8Array>,
  handleLine: (line: string) => void,
): Promise<void> {
  const frames = new CommandLineBuffer();
  for await (const chunk of stream) {
    for (const line of frames.push(chunk)) {
      handleLine(line);
    }
  }
}

/** The live entrypoint: real config, real `SessionManager`, real stdio. */
async function main(): Promise<void> {
  const config = resolveConfig();
  const logger = createLogger(config.logLevel, 'sidecar');
  const manager = new SessionManager(config, logger);

  const { handleLine } = createSidecar(manager, (line) => {
    process.stdout.write(line);
  });

  process.stderr.write('nightcore-sidecar ready\n');
  await pumpCommands(Bun.stdin.stream(), handleLine);
}

if (import.meta.main) {
  void main();
}
