/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test';

import type {
  NightcoreEvent,
  NightcoreEventOf,
  SurfaceCommand,
  SurfaceQuery,
} from '@nightcore/contracts';

import {
  CommandLineBuffer,
  createSidecar,
  encodeEvent,
  pumpCommands,
  type SidecarManager,
} from './index.js';

/**
 * No live Claude session is ever created here. We never import or instantiate
 * `SessionManager`, never call `resolveConfig`, and never load the Claude Agent
 * SDK — the sidecar drives a hand-written `StubManager` that only records the
 * commands it receives and replays scripted events. Importing `./index.js` runs
 * no `main()` because the live entrypoint is guarded by `import.meta.main`, which
 * is false under the test runner. So: no model spawn, no token use, no cost.
 */
class StubManager implements SidecarManager {
  readonly dispatched: SurfaceCommand[] = [];
  readonly queried: SurfaceQuery[] = [];
  private listener: ((event: NightcoreEvent) => void) | null = null;

  on(listener: (event: NightcoreEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  dispatch = mock(async (command: SurfaceCommand): Promise<void> => {
    this.dispatched.push(command);
  });

  /** Echo the query back as a minimal `query-result` (no live SDK / disk read). */
  handleQuery = mock(
    async (query: SurfaceQuery): Promise<NightcoreEventOf<'query-result'>> => {
      this.queried.push(query);
      return {
        type: 'query-result',
        requestId: query.requestId,
        ok: true,
        kind: 'sessions',
        sessions: [],
      };
    },
  );

  /** Simulate the engine emitting an event (no real session involved). */
  emit(event: NightcoreEvent): void {
    this.listener?.(event);
  }
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Build an async-iterable byte stream from a list of chunks (mimics stdin). */
async function* streamOf(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

describe('encodeEvent', () => {
  test('serializes one event to exactly one newline-terminated JSON line', () => {
    const event: NightcoreEvent = {
      type: 'assistant-delta',
      sessionId: 1,
      text: 'hello',
      partial: true,
    };
    const line = encodeEvent(event);
    expect(line.endsWith('\n')).toBe(true);
    // Exactly one line: only the trailing newline, none embedded.
    expect(line.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual(event);
  });
});

describe('CommandLineBuffer', () => {
  test('splits multiple commands on newlines', () => {
    const buffer = new CommandLineBuffer();
    const lines = buffer.push(utf8('{"a":1}\n{"b":2}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test('reassembles a command split across chunks', () => {
    const buffer = new CommandLineBuffer();
    expect(buffer.push(utf8('{"type":"inter'))).toEqual([]);
    expect(buffer.push(utf8('rupt","sessionId":3}\n'))).toEqual([
      '{"type":"interrupt","sessionId":3}',
    ]);
  });

  test('skips blank and whitespace-only lines', () => {
    const buffer = new CommandLineBuffer();
    expect(buffer.push(utf8('\n  \n{"x":1}\n'))).toEqual(['{"x":1}']);
  });

  test('holds an unterminated trailing line until its newline arrives', () => {
    const buffer = new CommandLineBuffer();
    expect(buffer.push(utf8('{"partial":true}'))).toEqual([]);
    expect(buffer.push(utf8('\n'))).toEqual(['{"partial":true}']);
  });

  test('does not corrupt a multibyte char split across chunks', () => {
    const buffer = new CommandLineBuffer();
    const bytes = utf8('{"t":"€"}\n'); // € is 3 bytes
    const splitAt = 5;
    expect(buffer.push(bytes.slice(0, splitAt))).toEqual([]);
    const [line] = buffer.push(bytes.slice(splitAt));
    expect(JSON.parse(line!)).toEqual({ t: '€' });
  });

  test('drops a newline-free line over the cap and resynchronizes', () => {
    // A small cap makes the DoS guard testable without allocating gigabytes: a
    // newline-free blob past the cap must be dropped whole (not accumulated), and
    // the next complete line must still parse — proving memory stays bounded.
    const buffer = new CommandLineBuffer(64);
    // Feed 200 newline-free chars in chunks: nothing is yielded and the buffer
    // does not grow without bound (it is discarded once past the cap).
    expect(buffer.push(utf8('x'.repeat(200)))).toEqual([]);
    // The newline that finally arrives closes the discarded oversized line; the
    // trailing valid command after it parses normally.
    expect(buffer.push(utf8('leftover\n{"ok":true}\n'))).toEqual(['{"ok":true}']);
  });

  test('overflow across multiple chunks still resynchronizes at the next newline', () => {
    const buffer = new CommandLineBuffer(64);
    expect(buffer.push(utf8('a'.repeat(50)))).toEqual([]);
    expect(buffer.push(utf8('b'.repeat(50)))).toEqual([]); // now over the cap → dropped
    expect(buffer.push(utf8('c'.repeat(50)))).toEqual([]); // still skipping
    expect(buffer.push(utf8('\n{"next":1}\n'))).toEqual(['{"next":1}']);
  });
});

describe('createSidecar — event sink', () => {
  test('every emitted event is framed to one stdout line', () => {
    const manager = new StubManager();
    const lines: string[] = [];
    createSidecar(manager, (line) => lines.push(line));

    const events: NightcoreEvent[] = [
      { type: 'assistant-delta', sessionId: 1, text: 'hi', partial: true },
      {
        type: 'session-completed',
        sessionId: 1,
        result: 'done',
        costUsd: 0.01,
        numTurns: 1,
        durationMs: 5,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    ];
    for (const event of events) manager.emit(event);

    expect(lines).toHaveLength(2);
    for (const [i, line] of lines.entries()) {
      expect(line.endsWith('\n')).toBe(true);
      expect(line.trimEnd().includes('\n')).toBe(false);
      expect(JSON.parse(line)).toEqual(events[i]);
    }
  });

  test('relays a permission request without answering it', () => {
    const manager = new StubManager();
    const lines: string[] = [];
    createSidecar(manager, (line) => lines.push(line));

    manager.emit({
      type: 'permission-required',
      sessionId: 7,
      requestId: 'req-1',
      toolName: 'shell',
      input: { command: 'rm -rf /' },
    });

    // The event is forwarded to the core verbatim...
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: 'permission-required',
      sessionId: 7,
      requestId: 'req-1',
      toolName: 'shell',
    });
    // ...and the sidecar dispatches NOTHING back: the request parks in the engine
    // until the Rust core sends an interactive (or fail-closed) decision.
    expect(manager.dispatched).toEqual([]);
  });

  test('a hot assistant-delta is fast-pathed to the wire without full revalidation', () => {
    const manager = new StubManager();
    const lines: string[] = [];
    const errors: string[] = [];
    createSidecar(manager, (line) => lines.push(line), (m) => errors.push(m));

    // Shape-invalid on paper (`partial` should be a boolean), but assistant-delta
    // is the per-token hot path: the sidecar trusts the typed translator and
    // forwards it WITHOUT paying for a union safeParse on every streamed token.
    // It reaches the wire verbatim and nothing is dropped or logged.
    manager.emit({
      type: 'assistant-delta',
      sessionId: 1,
      text: 'chunk',
      partial: 'nope',
    } as unknown as NightcoreEvent);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: 'assistant-delta',
      text: 'chunk',
    });
    expect(errors).toEqual([]);
  });

  test('a malformed low-frequency event is still dropped and logged, not shipped', () => {
    const manager = new StubManager();
    const lines: string[] = [];
    const errors: string[] = [];
    createSidecar(manager, (line) => lines.push(line), (m) => errors.push(m));

    // session-completed is NOT fast-pathed, so outbound validation still runs and
    // catches a contract gap (missing required fields) before it hits the wire —
    // the fast-path narrows what skips validation, it doesn't disable it.
    manager.emit({
      type: 'session-completed',
      sessionId: 1,
    } as unknown as NightcoreEvent);

    expect(lines).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      'dropping malformed outbound event (session-completed)',
    );
  });
});

describe('createSidecar — command dispatch', () => {
  test('parses a valid NDJSON command and dispatches it', () => {
    const manager = new StubManager();
    const { handleLine } = createSidecar(manager, () => {});
    handleLine('{"type":"start-session","prompt":"build it"}');
    expect(manager.dispatched).toEqual([
      { type: 'start-session', prompt: 'build it' },
    ]);
  });

  test('a malformed line is reported and never dispatched or thrown', () => {
    const manager = new StubManager();
    const errors: string[] = [];
    const { handleLine } = createSidecar(manager, () => {}, (m) =>
      errors.push(m),
    );

    expect(() => handleLine('{ not json')).not.toThrow();
    expect(manager.dispatched).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('bad command json');
  });

  test('valid JSON that is not a valid command is rejected, not dispatched', () => {
    const manager = new StubManager();
    const errors: string[] = [];
    const { handleLine } = createSidecar(manager, () => {}, (m) =>
      errors.push(m),
    );

    // Well-formed JSON, but not a member of the SurfaceCommand union (unknown
    // `type`, and missing the fields the schema requires). Pre-fix this was cast
    // straight to SurfaceCommand and dispatched, smuggling a junk command into
    // the engine; it must now be caught by SurfaceCommandSchema and skipped.
    expect(() =>
      handleLine('{"type":"definitely-not-a-command","foo":1}'),
    ).not.toThrow();
    expect(manager.dispatched).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('invalid command');
  });

  test('a command with the right type but a wrong field shape is rejected', () => {
    const manager = new StubManager();
    const errors: string[] = [];
    const { handleLine } = createSidecar(manager, () => {}, (m) =>
      errors.push(m),
    );

    // `interrupt` requires a numeric sessionId; a string must fail validation.
    handleLine('{"type":"interrupt","sessionId":"not-a-number"}');
    expect(manager.dispatched).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('invalid command');
  });

  test('an invalid command does not stop later valid commands', () => {
    const manager = new StubManager();
    const { handleLine } = createSidecar(manager, () => {}, () => {});
    handleLine('{"type":"definitely-not-a-command"}');
    handleLine('{"type":"interrupt","sessionId":2}');
    expect(manager.dispatched).toEqual([{ type: 'interrupt', sessionId: 2 }]);
  });

  test('a bad line does not stop later valid commands', () => {
    const manager = new StubManager();
    const { handleLine } = createSidecar(manager, () => {}, () => {});
    handleLine('garbage');
    handleLine('{"type":"interrupt","sessionId":2}');
    expect(manager.dispatched).toEqual([
      { type: 'interrupt', sessionId: 2 },
    ]);
  });
});

describe('createSidecar — query request/reply', () => {
  test('a query line is routed to handleQuery and its result is emitted with the matching requestId', async () => {
    const manager = new StubManager();
    const lines: string[] = [];
    const { handleLine } = createSidecar(manager, (line) => lines.push(line));

    handleLine('{"type":"list-sessions","requestId":"req-9","dir":"/proj"}');
    // handleQuery resolves on a microtask; let it settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.queried).toEqual([
      { type: 'list-sessions', requestId: 'req-9', dir: '/proj' },
    ]);
    // No command was dispatched — a query is not a command.
    expect(manager.dispatched).toEqual([]);
    // The reply is framed back through the sink as a query-result echoing requestId.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      type: 'query-result',
      requestId: 'req-9',
      ok: true,
      kind: 'sessions',
      sessions: [],
    });
  });

  test('a line that is neither a command nor a query is reported, not handled', () => {
    const manager = new StubManager();
    const errors: string[] = [];
    const { handleLine } = createSidecar(manager, () => {}, (m) => errors.push(m));

    handleLine('{"type":"list-sessions"}'); // missing requestId → invalid query
    expect(manager.queried).toEqual([]);
    expect(manager.dispatched).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('invalid command');
  });

  test('a query does not stop later commands', () => {
    const manager = new StubManager();
    const { handleLine } = createSidecar(manager, () => {});
    handleLine('{"type":"get-session-info","requestId":"r1","sdkSessionId":"u1"}');
    handleLine('{"type":"interrupt","sessionId":2}');
    expect(manager.queried).toHaveLength(1);
    expect(manager.dispatched).toEqual([{ type: 'interrupt', sessionId: 2 }]);
  });
});

describe('pumpCommands — end-to-end framing over a stdin stream', () => {
  test('frames commands across chunk boundaries and dispatches each once', async () => {
    const manager = new StubManager();
    const { handleLine } = createSidecar(manager, () => {});

    await pumpCommands(
      streamOf([
        utf8('{"type":"start-session",'),
        utf8('"prompt":"a"}\n{"type":"inter'),
        utf8('rupt","sessionId":1}\n'),
      ]),
      handleLine,
    );

    expect(manager.dispatched).toEqual([
      { type: 'start-session', prompt: 'a' },
      { type: 'interrupt', sessionId: 1 },
    ]);
  });
});
