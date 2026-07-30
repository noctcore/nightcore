import { describe, expect, test } from 'vitest';

import type { WorktreeInfo } from '@/lib/bridge';

import { branchForCwd } from './TerminalTabs.hooks';

function worktree(branch: string, path: string): WorktreeInfo {
  return {
    branch,
    path,
    taskIds: [],
    dirty: false,
    aheadOfBase: 0,
    behindOfBase: 0,
    changedFiles: 0,
  };
}

describe('branchForCwd (#405 tab metadata)', () => {
  const worktrees = [
    worktree('feat/dark-mode', '/repo/.nightcore/worktrees/dark-mode'),
    worktree('fix/login', '/repo/.nightcore/worktrees/login'),
  ];

  test('reports the branch for a cwd AT a worktree root', () => {
    expect(branchForCwd(worktrees, '/repo/.nightcore/worktrees/dark-mode')).toBe('feat/dark-mode');
  });

  test('reports the branch for a cwd nested inside a worktree', () => {
    expect(branchForCwd(worktrees, '/repo/.nightcore/worktrees/login/apps/web')).toBe('fix/login');
  });

  test('reports nothing for a cwd that is not in any worktree', () => {
    // The repo root and any browsed folder: no branch to claim, so no chip. Returning
    // the repo's current branch here would be a lie — that shell is not on it.
    expect(branchForCwd(worktrees, '/repo')).toBeNull();
    expect(branchForCwd(worktrees, '/Users/dev/Documents')).toBeNull();
    expect(branchForCwd([], '/repo/.nightcore/worktrees/dark-mode')).toBeNull();
  });

  test('a sibling with a longer name is NOT a prefix match', () => {
    // `/…/login-experiment` starts with `/…/login`, so a naive `startsWith` would
    // label it `fix/login` — the wrong branch on the wrong tab.
    expect(branchForCwd(worktrees, '/repo/.nightcore/worktrees/login-experiment')).toBeNull();
  });

  test('a nested worktree wins over the parent that contains it', () => {
    const nested = [
      worktree('outer', '/repo/wt'),
      worktree('inner', '/repo/wt/nested'),
    ];
    expect(branchForCwd(nested, '/repo/wt/nested/src')).toBe('inner');
    expect(branchForCwd(nested, '/repo/wt/src')).toBe('outer');
  });

  test('matches on a Windows separator boundary too', () => {
    const win = [worktree('feat/x', 'C:\\repo\\wt\\x')];
    expect(branchForCwd(win, 'C:\\repo\\wt\\x\\apps')).toBe('feat/x');
    expect(branchForCwd(win, 'C:\\repo\\wt\\x2')).toBeNull();
  });
});
