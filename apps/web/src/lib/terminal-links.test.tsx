import { beforeEach, describe, expect, test, vi } from 'vitest';

// #405: the durable half of the marker lives in Rust. Spy on the bridge so the tests
// can prove the gesture actually reaches it — a marker that only updates this module
// is precisely the bug the issue calls a lie.
const markTerminalUngoverned = vi.fn<(id: string, reason: string) => Promise<void>>(
  () => Promise.resolve(),
);
const clearTerminalGovernanceMark = vi.fn<(id: string, reason: string) => Promise<void>>(
  () => Promise.resolve(),
);
vi.mock('./bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bridge')>();
  return {
    ...actual,
    markTerminalUngoverned: (id: string, reason: string) => markTerminalUngoverned(id, reason),
    clearTerminalGovernanceMark: (id: string, reason: string) =>
      clearTerminalGovernanceMark(id, reason),
  };
});

import {
  clearSessionTaskLink,
  consumePendingActivateSession,
  forgetSession,
  getSessionForTask,
  getTaskForSession,
  isUngovernedSession,
  linkTaskToSession,
  markClaudeLaunched,
  reconcileTerminalLinks,
  requestActivateSession,
  resetTerminalLinksForTest,
  subscribeTerminalLinks,
} from './terminal-links';

beforeEach(() => {
  resetTerminalLinksForTest();
  markTerminalUngoverned.mockClear();
  clearTerminalGovernanceMark.mockClear();
});

describe('persisted governance markers (#405)', () => {
  test('launching claude records the PERMANENT marker server-side', () => {
    markClaudeLaunched('sess-1');
    expect(markTerminalUngoverned).toHaveBeenCalledWith('sess-1', 'claudeLaunched');
  });

  test('linking a task records the REVOCABLE marker server-side', () => {
    linkTaskToSession('task-1', 'sess-1');
    expect(markTerminalUngoverned).toHaveBeenCalledWith('sess-1', 'taskLinked');
  });

  test('clearing a link only ever asks to revoke the task reason', () => {
    linkTaskToSession('task-1', 'sess-1');
    clearSessionTaskLink('sess-1');
    expect(clearTerminalGovernanceMark).toHaveBeenCalledWith('sess-1', 'taskLinked');
    expect(clearTerminalGovernanceMark).not.toHaveBeenCalledWith('sess-1', 'claudeLaunched');
  });

  test('a re-link still re-asserts the marker (the write is idempotent server-side)', () => {
    // The early-return for an already-identical pair must not skip the durable write:
    // the local map can be in sync while the file is not (a failed write, a new run).
    linkTaskToSession('task-1', 'sess-1');
    linkTaskToSession('task-1', 'sess-1');
    expect(markTerminalUngoverned).toHaveBeenCalledTimes(2);
  });
});

describe('linking', () => {
  test('links a task and a session both ways and marks it ungoverned', () => {
    linkTaskToSession('task-1', 'sess-1');
    expect(getSessionForTask('task-1')).toBe('sess-1');
    expect(getTaskForSession('sess-1')).toBe('task-1');
    expect(isUngovernedSession('sess-1')).toBe(true);
  });

  test('a task links to at most one session (re-link moves it)', () => {
    linkTaskToSession('task-1', 'sess-1');
    linkTaskToSession('task-1', 'sess-2');
    expect(getSessionForTask('task-1')).toBe('sess-2');
    expect(getTaskForSession('sess-1')).toBeNull();
    expect(getTaskForSession('sess-2')).toBe('task-1');
  });

  test('a session links to at most one task (re-pick replaces)', () => {
    linkTaskToSession('task-1', 'sess-1');
    linkTaskToSession('task-2', 'sess-1');
    expect(getTaskForSession('sess-1')).toBe('task-2');
    expect(getSessionForTask('task-1')).toBeNull();
  });

  test('clearing a link drops both directions but keeps claude-launched', () => {
    linkTaskToSession('task-1', 'sess-1');
    markClaudeLaunched('sess-1');
    clearSessionTaskLink('sess-1');
    expect(getTaskForSession('sess-1')).toBeNull();
    expect(getSessionForTask('task-1')).toBeNull();
    expect(isUngovernedSession('sess-1')).toBe(true); // still claude-launched
  });
});

describe('ungoverned marker', () => {
  test('a claude-launched session is ungoverned even without a task', () => {
    markClaudeLaunched('sess-1');
    expect(isUngovernedSession('sess-1')).toBe(true);
    expect(getTaskForSession('sess-1')).toBeNull();
  });
});

describe('reconcile + forget', () => {
  test('reconcile drops links whose session is no longer live', () => {
    linkTaskToSession('task-1', 'sess-1');
    markClaudeLaunched('sess-2');
    reconcileTerminalLinks(['sess-2']); // sess-1 gone
    expect(getTaskForSession('sess-1')).toBeNull();
    expect(getSessionForTask('task-1')).toBeNull();
    expect(isUngovernedSession('sess-2')).toBe(true);
  });

  test('forgetSession clears every marker for a closed session', () => {
    linkTaskToSession('task-1', 'sess-1');
    markClaudeLaunched('sess-1');
    forgetSession('sess-1');
    expect(isUngovernedSession('sess-1')).toBe(false);
    expect(getSessionForTask('task-1')).toBeNull();
  });
});

describe('subscription + pending activation', () => {
  test('subscribers fire on a link change', () => {
    const listener = vi.fn();
    const unsub = subscribeTerminalLinks(listener);
    linkTaskToSession('task-1', 'sess-1');
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    linkTaskToSession('task-2', 'sess-2');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('a pending activation is consumed exactly once', () => {
    requestActivateSession('sess-9');
    expect(consumePendingActivateSession()).toBe('sess-9');
    expect(consumePendingActivateSession()).toBeNull();
  });
});
