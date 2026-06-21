/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { NightcoreEvent } from '@nightcore/contracts';
import { initialView, reduce } from './session-reducer.js';
import type { SessionView } from './types.js';

function base(): SessionView {
  return initialView('claude-sonnet', 'plan', null);
}

describe('task-updated fold', () => {
  test('upserts a task by id and merges patch fields', () => {
    let view = base();
    view = reduce(view, {
      type: 'task-updated',
      sessionId: 1,
      taskId: 't1',
      status: 'running',
      description: 'Exploring the repo',
      subagentType: 'Explore',
      ambient: false,
    } satisfies NightcoreEvent);

    expect(view.tasks.size).toBe(1);
    expect(view.tasks.get('t1')).toEqual({
      taskId: 't1',
      status: 'running',
      description: 'Exploring the repo',
      summary: undefined,
      subagentType: 'Explore',
      ambient: false,
    });

    // A status-only patch must keep the earlier description + subagentType.
    view = reduce(view, {
      type: 'task-updated',
      sessionId: 1,
      taskId: 't1',
      status: 'completed',
      summary: '12 files read',
      ambient: false,
    } satisfies NightcoreEvent);

    expect(view.tasks.size).toBe(1);
    expect(view.tasks.get('t1')).toEqual({
      taskId: 't1',
      status: 'completed',
      description: 'Exploring the repo',
      summary: '12 files read',
      subagentType: 'Explore',
      ambient: false,
    });
  });

  test('keys by taskId, never by index — order preserved', () => {
    let view = base();
    for (const id of ['a', 'b', 'c']) {
      view = reduce(view, {
        type: 'task-updated',
        sessionId: 1,
        taskId: id,
        status: 'pending',
        description: id,
        ambient: false,
      } satisfies NightcoreEvent);
    }
    expect([...view.tasks.keys()]).toEqual(['a', 'b', 'c']);
  });

  test('session-started resets tasks', () => {
    let view = base();
    view = reduce(view, {
      type: 'task-updated',
      sessionId: 1,
      taskId: 't1',
      status: 'running',
      ambient: false,
    } satisfies NightcoreEvent);
    expect(view.tasks.size).toBe(1);

    view = reduce(view, {
      type: 'session-started',
      sessionId: 2,
      prompt: 'hi',
      model: 'claude-sonnet',
      permissionMode: 'plan',
    } satisfies NightcoreEvent);
    expect(view.tasks.size).toBe(0);
  });
});

describe('session-ready folds the command palette', () => {
  test('stores slashCommands and skills', () => {
    let view = base();
    view = reduce(view, {
      type: 'session-ready',
      sessionId: 1,
      sdkSessionId: 'sdk-1',
      model: 'claude-sonnet',
      tools: ['Read'],
      slashCommands: ['compact', 'cost'],
      skills: ['frontend-design'],
    } satisfies NightcoreEvent);
    expect(view.slashCommands).toEqual(['compact', 'cost']);
    expect(view.skills).toEqual(['frontend-design']);
  });
});

describe('session-completed folds duration + usage', () => {
  test('stores durationMs and usage and renders a rich notice', () => {
    let view = base();
    view = reduce(view, {
      type: 'session-completed',
      sessionId: 1,
      result: 'ok',
      costUsd: 0.1234,
      numTurns: 3,
      durationMs: 3210,
      usage: {
        inputTokens: 12300,
        outputTokens: 4500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    } satisfies NightcoreEvent);

    expect(view.durationMs).toBe(3210);
    expect(view.usage?.inputTokens).toBe(12300);

    const last = view.transcript.at(-1);
    expect(last?.kind).toBe('notice');
    if (last?.kind === 'notice') {
      expect(last.text).toContain('3 turn(s)');
      expect(last.text).toContain('$0.1234');
      expect(last.text).toContain('3.2s');
      expect(last.text).toContain('↑12.3k ↓4.5k');
    }
  });
});
