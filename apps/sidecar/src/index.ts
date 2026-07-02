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
import {
  type NightcoreEvent,
  type NightcoreEventOf,
  NightcoreEventSchema,
  type SurfaceCommand,
  SurfaceCommandSchema,
  type SurfaceQuery,
  SurfaceQuerySchema,
} from '@nightcore/contracts';
import { SessionManager } from '@nightcore/engine';
import { createLogger, type Logger } from '@nightcore/shared';

/** Emits one already-framed `NightcoreEvent` line to the wire. The live sink
 *  writes to stdout; tests inject a collector to assert framing. */
export type EventSink = (line: string) => void;

/** The minimal slice of `SessionManager` the sidecar drives. Declaring it as an
 *  interface lets tests pass a stub so no live Claude session is ever created. */
export interface SidecarManager {
  on(listener: (event: NightcoreEvent) => void): () => void;
  dispatch(command: SurfaceCommand): Promise<void>;
  /** Answer a request/reply `SurfaceQuery` against the SDK session store; the
   *  resolved `query-result` event is emitted through the same sink so the Rust
   *  core can correlate it by `requestId`. */
  handleQuery(query: SurfaceQuery): Promise<NightcoreEventOf<'query-result'>>;
}

/** Serialize one `NightcoreEvent` to its NDJSON wire form (exactly one line). */
export function encodeEvent(event: NightcoreEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Outbound event types that skip the full discriminated-union `safeParse` on the
 * way to the wire. Membership requires BOTH: the variant is constructed only by
 * typed translator code (`translateMessage`) — never from untrusted input, so its
 * shape is already guaranteed by the `NightcoreEvent[]` return type — AND it is
 * high-frequency. `assistant-delta` fires once per token-level
 * `content_block_delta` (hundreds–thousands per assistant turn, for every live
 * session concurrently); a union `safeParse` walks variants and revalidates every
 * field per delta, which materially outweighs the `JSON.stringify` that follows
 * and buys nothing the type system hasn't already guaranteed. Every other event
 * is low-frequency (lifecycle/terminal), so full validation stays on there where
 * the cost is negligible and an upstream contract gap actually matters.
 */
const FAST_PATH_EVENT_TYPES = new Set<NightcoreEvent['type']>(['assistant-delta']);

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
 * - Permission requests are RELAYED, not auto-denied: a `permission-required`
 *   event reaches the wire like any other and the session parks in the engine
 *   awaiting a surface decision. The Rust core surfaces the prompt to the UI and
 *   sends back an `approve-permission` command (interactively, or a fail-closed
 *   deny on cancel/abort) — long waits are fine, the engine settles the parked
 *   request when the decision arrives. The sidecar stays dumb; it answers nothing
 *   on its own.
 * - The returned `handleLine` parses one NDJSON command, validates it against
 *   `SurfaceCommandSchema`, and dispatches it. It logs (never throws) on either
 *   malformed JSON OR a command that fails schema validation, so one bad line
 *   can't kill the stream. A rejected `dispatch` is caught and logged for the
 *   same reason — the manager degrades-not-throws, but a defensive `.catch`
 *   keeps an unexpected rejection from becoming an unhandled rejection that
 *   tears down the process.
 */
export function createSidecar(
  manager: SidecarManager,
  sink: EventSink,
  onError: (message: string) => void = (m) => process.stderr.write(`${m}\n`),
): { handleLine: (line: string) => void } {
  manager.on((event) => {
    // Fast-path the hot, typed-translator-constructed variants (see
    // FAST_PATH_EVENT_TYPES): a full union safeParse would otherwise run once per
    // streamed token and dominate per-delta CPU, revalidating a shape the type
    // system already guarantees.
    if (FAST_PATH_EVENT_TYPES.has(event.type)) {
      sink(encodeEvent(event));
      return;
    }
    // Validate OUTBOUND too (the inbound command path already does): the engine
    // constructs events from SDK output, so an upstream gap could emit a
    // contract-invalid event that the Rust core / web then decode differently.
    // Drop-and-log on mismatch rather than shipping a malformed line.
    const valid = NightcoreEventSchema.safeParse(event);
    if (!valid.success) {
      onError(`sidecar: dropping malformed outbound event (${event.type}): ${valid.error.message}`);
      return;
    }
    sink(encodeEvent(event));
  });

  function handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      onError(`sidecar: bad command json: ${String(error)}`);
      return;
    }
    // A line is EITHER a fire-and-forget command OR a request/reply query — the
    // two unions share no `type` discriminant, so try the command first and fall
    // back to the query. Both degrade-not-throw: a bad line logs, never kills the
    // stream.
    const command = SurfaceCommandSchema.safeParse(parsed);
    if (command.success) {
      void manager.dispatch(command.data).catch((error: unknown) => {
        onError(`sidecar: dispatch failed: ${String(error)}`);
      });
      return;
    }
    const query = SurfaceQuerySchema.safeParse(parsed);
    if (query.success) {
      // The reply is emitted through the SAME event sink as a `query-result`
      // event; the Rust reader intercepts it by `requestId`. `handleQuery` is
      // degrade-not-throw, but a defensive `.catch` guards an unexpected rejection.
      manager
        .handleQuery(query.data)
        .then((result) => {
          sink(encodeEvent(result));
        })
        .catch((error: unknown) => {
          onError(`sidecar: query failed: ${String(error)}`);
        });
      return;
    }
    onError(`sidecar: invalid command: ${command.error.message}`);
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

/** Install last-resort process guards so a stray throw/rejection anywhere in the
 *  sidecar is logged (never silent) before the process exits. The protocol is
 *  degrade-not-throw end to end; these are the backstop for the unexpected. */
function installProcessGuards(logger: Logger): void {
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', error);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', reason);
  });
}

/** The live entrypoint: real config, real `SessionManager`, real stdio. */
async function main(): Promise<void> {
  const config = resolveConfig();
  const logger = createLogger(config.logLevel, 'sidecar');
  installProcessGuards(logger);
  const manager = new SessionManager(config, logger);

  const { handleLine } = createSidecar(
    manager,
    (line) => {
      process.stdout.write(line);
    },
    (message) => logger.warn(message),
  );

  process.stderr.write('nightcore-sidecar ready\n');
  await pumpCommands(Bun.stdin.stream(), handleLine);
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    // main() should never reject (pumpCommands runs until stdin closes), but if
    // it does the loop is dead — log and exit non-zero so the Rust core's child
    // watcher sees the failure rather than a silent hang.
    createLogger('error', 'sidecar').error('fatal: sidecar exited', error);
    process.exitCode = 1;
  });
}
