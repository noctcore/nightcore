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
