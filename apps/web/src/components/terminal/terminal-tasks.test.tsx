import { describe, expect, test } from 'vitest';

import { makeTerminalSession, makeTerminalTask } from './_fixtures';
import { pickableTasksForTerminal, ungovernedSessionIds } from './terminal-tasks';

describe('ungovernedSessionIds (#405)', () => {
  test('a session the SERVER marked is ungoverned with no local mark at all', () => {
    // The restart case. Nothing in this process remembers the launch — the marker
    // arrives purely on the descriptor, read back from `governance.json`. Before #405
    // this session rendered as an ordinary governed tab.
    const restarted = makeTerminalSession({ id: 'survivor', ungoverned: true });
    const ids = ungovernedSessionIds([restarted], () => false);
    expect([...ids]).toEqual(['survivor']);
  });

  test('the optimistic local mark still lights the bolt before the mark round-trips', () => {
    const justLaunched = makeTerminalSession({ id: 'fresh', ungoverned: false });
    const ids = ungovernedSessionIds([justLaunched], (id) => id === 'fresh');
    expect([...ids]).toEqual(['fresh']);
  });

  test('an unmarked session on both sides stays governed', () => {
    const plain = makeTerminalSession({ id: 'plain', ungoverned: false });
    expect([...ungovernedSessionIds([plain], () => false)]).toEqual([]);
  });

  test('the two halves union rather than override each other', () => {
    const sessions = [
      makeTerminalSession({ id: 'server-only', ungoverned: true }),
      makeTerminalSession({ id: 'local-only', ungoverned: false }),
      makeTerminalSession({ id: 'neither', ungoverned: false }),
    ];
    const ids = ungovernedSessionIds(sessions, (id) => id === 'local-only');
    expect([...ids].sort()).toEqual(['local-only', 'server-only']);
  });
});

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
