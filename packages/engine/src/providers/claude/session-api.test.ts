/// <reference types="bun" />
import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Unit-test the `SessionApi` wrappers against a STUBBED SDK module — no live
 * `query`, no model spawn, no token use. `mock.module` replaces the SDK boundary
 * import so each wrapper's option pass-through and degrade-on-throw behavior is
 * asserted in isolation. The stub functions are reset per test.
 */
const listSessions = mock(() => Promise.resolve([] as unknown[]));
const getSessionInfo = mock(() => Promise.resolve<unknown>(undefined));
const getSessionMessages = mock(() => Promise.resolve([] as unknown[]));
const renameSession = mock(() => Promise.resolve<unknown>(undefined));
const tagSession = mock(() => Promise.resolve<unknown>(undefined));

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  // The wrappers only touch these five; `query` is referenced by sdk-adapter's
  // module scope, so provide a harmless stub for it too.
  query: mock(() => {
    throw new Error('query must never be called by SessionApi');
  }),
  listSessions,
  getSessionInfo,
  getSessionMessages,
  renameSession,
  tagSession,
}));

const { SessionApi } = await import('./session-api.js');

beforeEach(() => {
  for (const m of [listSessions, getSessionInfo, getSessionMessages, renameSession, tagSession]) {
    m.mockClear();
  }
});

describe('SessionApi — option pass-through', () => {
  test('listTaskSessions forwards its options verbatim to the SDK', async () => {
    const api = new SessionApi();
    await api.listTaskSessions({ dir: '/proj', limit: 10, offset: 5, includeWorktrees: true });
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions.mock.calls[0]?.[0]).toEqual({
      dir: '/proj',
      limit: 10,
      offset: 5,
      includeWorktrees: true,
    });
  });

  test('getSessionInfoById passes the UUID and an empty options object by default', async () => {
    const api = new SessionApi();
    await api.getSessionInfoById('uuid-1');
    expect(getSessionInfo.mock.calls[0]?.[0]).toBe('uuid-1');
    expect(getSessionInfo.mock.calls[0]?.[1]).toEqual({});
  });

  test('getTaskSessionMessages forwards UUID + options (no dir = prune-safe)', async () => {
    const api = new SessionApi();
    await api.getTaskSessionMessages('uuid-2', { limit: 100, includeSystemMessages: true });
    expect(getSessionMessages.mock.calls[0]?.[0]).toBe('uuid-2');
    expect(getSessionMessages.mock.calls[0]?.[1]).toEqual({
      limit: 100,
      includeSystemMessages: true,
    });
  });

  test('renameTaskSession forwards UUID, title, and dir', async () => {
    const api = new SessionApi();
    const ok = await api.renameTaskSession('uuid-3', 'New title', { dir: '/proj' });
    expect(ok).toBe(true);
    expect(renameSession.mock.calls[0]).toEqual(['uuid-3', 'New title', { dir: '/proj' }]);
  });

  test('tagTaskSession forwards a null tag to clear it', async () => {
    const api = new SessionApi();
    const ok = await api.tagTaskSession('uuid-4', null);
    expect(ok).toBe(true);
    expect(tagSession.mock.calls[0]).toEqual(['uuid-4', null, {}]);
  });
});

describe('SessionApi — degrade-not-throw', () => {
  test('listTaskSessions returns [] when the SDK throws', async () => {
    listSessions.mockImplementationOnce(async () => {
      throw new Error('disk gone');
    });
    const api = new SessionApi();
    await expect(api.listTaskSessions()).resolves.toEqual([]);
  });

  test('getSessionInfoById returns undefined when the SDK throws', async () => {
    getSessionInfo.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const api = new SessionApi();
    await expect(api.getSessionInfoById('x')).resolves.toBeUndefined();
  });

  test('getTaskSessionMessages returns [] when the SDK throws', async () => {
    getSessionMessages.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const api = new SessionApi();
    await expect(api.getTaskSessionMessages('x')).resolves.toEqual([]);
  });

  test('renameTaskSession returns false when the SDK throws', async () => {
    renameSession.mockImplementationOnce(async () => {
      throw new Error('locked');
    });
    const api = new SessionApi();
    await expect(api.renameTaskSession('x', 't')).resolves.toBe(false);
  });

  test('tagTaskSession returns false when the SDK throws', async () => {
    tagSession.mockImplementationOnce(async () => {
      throw new Error('locked');
    });
    const api = new SessionApi();
    await expect(api.tagTaskSession('x', 'tag')).resolves.toBe(false);
  });
});
