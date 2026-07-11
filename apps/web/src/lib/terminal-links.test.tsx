import { beforeEach, describe, expect, test, vi } from 'vitest';

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
