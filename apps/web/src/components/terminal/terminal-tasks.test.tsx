import { describe, expect, test } from 'vitest';

import { makeTerminalTask } from './_fixtures';
import { pickableTasksForTerminal } from './terminal-tasks';

describe('pickableTasksForTerminal', () => {
  test('keeps only pre-run tasks (backlog/ready), most-recent first', () => {
    const tasks = [
      makeTerminalTask({ id: 'a', status: 'backlog', updatedAt: 1 }),
      makeTerminalTask({ id: 'b', status: 'done', updatedAt: 5 }),
      makeTerminalTask({ id: 'c', status: 'ready', updatedAt: 3 }),
      makeTerminalTask({ id: 'd', status: 'in_progress', updatedAt: 9 }),
    ];
    const picked = pickableTasksForTerminal(tasks);
    expect(picked.map((t) => t.id)).toEqual(['c', 'a']);
  });

  test('caps the list at the most-recent 20', () => {
    const tasks = Array.from({ length: 30 }, (_, i) =>
      makeTerminalTask({ id: `t-${i}`, status: 'backlog', updatedAt: i }),
    );
    const picked = pickableTasksForTerminal(tasks);
    expect(picked).toHaveLength(20);
    expect(picked[0]?.id).toBe('t-29'); // newest first
  });

  test('does not mutate the input array', () => {
    const tasks = [
      makeTerminalTask({ id: 'a', updatedAt: 1 }),
      makeTerminalTask({ id: 'b', updatedAt: 2 }),
    ];
    const before = tasks.map((t) => t.id);
    pickableTasksForTerminal(tasks);
    expect(tasks.map((t) => t.id)).toEqual(before);
  });
});
