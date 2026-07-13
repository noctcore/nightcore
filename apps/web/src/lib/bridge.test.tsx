import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// Mock the Tauri command/event surface so the bridge's `invoke`/`listen` calls
// are observable. The bridge gates real calls on `isTauri()`, which we satisfy by
// stubbing `window.__TAURI_INTERNALS__` in `beforeEach`.
const invoke = vi.fn();
const listen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...a) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

const bridge = await import('./bridge');

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

// --- The Settings concurrency slider invokes the registered backend command ----

test('setMaxConcurrency invokes the registered set_max_concurrency_cmd command', async () => {
  invoke.mockResolvedValue(undefined);
  await bridge.setMaxConcurrency(4);
  expect(invoke).toHaveBeenCalledWith('set_max_concurrency_cmd', { n: 4 });
});

// --- Council start/kill wrappers invoke the registered backend commands --------

test('startCouncil invokes start_council with the web-minted runId and preset', async () => {
  invoke.mockResolvedValue(undefined);
  await bridge.startCouncil('council-1', 'research', 'Pick a strategy.', '/proj');
  expect(invoke).toHaveBeenCalledWith('start_council', {
    runId: 'council-1',
    presetId: 'research',
    objective: 'Pick a strategy.',
    projectPath: '/proj',
  });
});

test('startCouncil defaults an omitted projectPath to null', async () => {
  invoke.mockResolvedValue(undefined);
  await bridge.startCouncil('council-2', 'research', 'Objective.');
  expect(invoke).toHaveBeenCalledWith('start_council', {
    runId: 'council-2',
    presetId: 'research',
    objective: 'Objective.',
    projectPath: null,
  });
});

test('killCouncil invokes kill_council with the run id', async () => {
  invoke.mockResolvedValue(undefined);
  await bridge.killCouncil('council-1');
  expect(invoke).toHaveBeenCalledWith('kill_council', { runId: 'council-1' });
});

// --- The nc:debate listener validates the entry before dispatching --------------

test('onDebateEvent forwards a valid debate-entry and drops a malformed payload', async () => {
  let registered: ((event: { payload: unknown }) => void) | undefined;
  listen.mockImplementation((name: string, cb: (e: { payload: unknown }) => void) => {
    expect(name).toBe('nc:debate');
    registered = cb;
    return Promise.resolve(() => {});
  });

  const received: unknown[] = [];
  await bridge.onDebateEvent((event) => received.push(event));
  expect(registered).toBeDefined();

  // A well-formed debate-entry event passes through.
  registered?.({
    payload: {
      type: 'debate-entry',
      runId: 'council-1',
      entry: {
        stage: 'propose',
        seatId: 'proposer-1',
        role: 'proposer',
        kind: 'message',
        seq: 0,
        content: 'My proposal.',
        at: 1718900000000,
      },
    },
  });
  // A malformed entry (bad enum) is dropped, not folded into the canvas.
  registered?.({
    payload: {
      type: 'debate-entry',
      runId: 'council-1',
      entry: { stage: 'not-a-stage', seatId: 's', role: 'proposer', kind: 'message', seq: 0, content: 'x', at: 1 },
    },
  });
  // A foreign channel event is dropped too.
  registered?.({ payload: { type: 'session-completed', sessionId: 1, result: 'x', numTurns: 1 } });

  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    type: 'debate-entry',
    runId: 'council-1',
    entry: { seatId: 'proposer-1', stage: 'propose' },
  });
});

// --- Transcript entries are validated against the contracts schema -------------

test('readTranscript drops entries that fail the event contract, keeping valid ones', async () => {
  invoke.mockResolvedValue([
    // Valid assistant-delta.
    { type: 'assistant-delta', sessionId: 1, text: 'hi', partial: true },
    // Garbage — must be dropped, not cast through.
    { type: 'assistant-delta', sessionId: 'not-a-number' },
    { nope: true },
    'string-line',
    // Valid tool-use-requested.
    {
      type: 'tool-use-requested',
      sessionId: 1,
      toolUseId: 'tu-1',
      toolName: 'Grep',
      input: { pattern: 'x' },
    },
  ]);

  const events = await bridge.readTranscript('task-1');
  expect(events).toHaveLength(2);
  expect(events.map((e) => e.type)).toEqual(['assistant-delta', 'tool-use-requested']);
});

test('readTranscript tolerates a non-array result (returns empty)', async () => {
  invoke.mockResolvedValue(null);
  expect(await bridge.readTranscript('task-1')).toEqual([]);
});

// --- The nc:session listener validates the inner event before dispatching ------

test('onSessionEvent forwards a valid envelope and drops a malformed event', async () => {
  // Capture the listener registered with `listen('nc:session', cb)`.
  let registered: ((event: { payload: unknown }) => void) | undefined;
  listen.mockImplementation((_name: string, cb: (e: { payload: unknown }) => void) => {
    registered = cb;
    return Promise.resolve(() => {});
  });

  const received: unknown[] = [];
  await bridge.onSessionEvent((env) => received.push(env));
  expect(registered).toBeDefined();

  // A well-formed envelope passes through.
  registered?.({
    payload: {
      taskId: 't1',
      event: { type: 'assistant-delta', sessionId: 1, text: 'hello', partial: true },
    },
  });
  // A malformed inner event is dropped (no throw, no dispatch).
  registered?.({ payload: { taskId: 't1', event: { type: 'assistant-delta' } } });
  // A bad envelope shape is dropped too.
  registered?.({ payload: { event: { type: 'assistant-delta', sessionId: 1, text: 'x', partial: true } } });

  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ taskId: 't1', event: { type: 'assistant-delta' } });
});
