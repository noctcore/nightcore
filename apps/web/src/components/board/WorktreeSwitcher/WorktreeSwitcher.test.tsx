import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render, renderHook } from 'vitest-browser-react';

import {
  MAIN_MODE_TASK,
  ORPHAN_BRANCH_TASK,
  PENDING_WORKTREE_TASK,
  TASKS_BY_STATUS,
  WORKTREES,
} from '../_fixtures';
import { filterTasksByWorktree, useWorktreeTabs } from './WorktreeSwitcher.hooks';
import * as stories from './WorktreeSwitcher.stories';

const { MainSelected, FallbackToTaskBranches, HiddenWhenOnlyMain } = composeStories(stories);

test('renders a Main tab plus one tab per live worktree', async () => {
  const screen = render(<MainSelected />);
  await expect.element(screen.getByRole('tab', { name: /^main/i })).toBeInTheDocument();
  await expect.element(screen.getByRole('tab', { name: /nc\/api-client/i })).toBeInTheDocument();
  await expect.element(screen.getByRole('tab', { name: /nc\/auth-guard/i })).toBeInTheDocument();
});

test('falls back to distinct task branches when no worktrees are live', async () => {
  const screen = render(<FallbackToTaskBranches />);
  await expect.element(screen.getByRole('tab', { name: /nc\/api-client/i })).toBeInTheDocument();
});

test('renders nothing when only the Main tab would exist', async () => {
  const screen = render(<HiddenWhenOnlyMain />);
  expect(screen.container.querySelector('[role="tablist"]')).toBeNull();
});

test('selecting a worktree tab reports its branch', async () => {
  const onSelect = vi.fn();
  const screen = render(<MainSelected onSelect={onSelect} />);
  await screen.getByRole('tab', { name: /nc\/auth-guard/i }).click();
  expect(onSelect).toHaveBeenCalledWith('nc/auth-guard');
});

test('filterTasksByWorktree: Main keeps run-mode-main tasks', () => {
  const tasks = [MAIN_MODE_TASK, TASKS_BY_STATUS.in_progress];
  expect(filterTasksByWorktree(tasks, null)).toEqual([MAIN_MODE_TASK]);
});

test('filterTasksByWorktree: a worktree tab keeps matching-branch tasks', () => {
  const tasks = [MAIN_MODE_TASK, TASKS_BY_STATUS.in_progress];
  expect(filterTasksByWorktree(tasks, 'nc/api-client')).toEqual([TASKS_BY_STATUS.in_progress]);
});

test('filterTasksByWorktree: Main keeps a branchless (pending) worktree task', () => {
  const tasks = [MAIN_MODE_TASK, PENDING_WORKTREE_TASK, TASKS_BY_STATUS.in_progress];
  expect(filterTasksByWorktree(tasks, null)).toEqual([MAIN_MODE_TASK, PENDING_WORKTREE_TASK]);
});

test('useWorktreeTabs: a branchless worktree task lands on Main with the right count', () => {
  const tasks = [MAIN_MODE_TASK, PENDING_WORKTREE_TASK];
  const { result } = renderHook(() => useWorktreeTabs(tasks, []));
  const main = result.current.find((tab) => tab.branch === null);
  expect(main?.taskCount).toBe(2);
  // A pending task with no branch spawns no phantom worktree tab.
  expect(result.current.filter((tab) => tab.branch !== null)).toEqual([]);
});

test('useWorktreeTabs: a task branch with no live worktree dir still gets a tab', () => {
  const tasks = [MAIN_MODE_TASK, ORPHAN_BRANCH_TASK];
  const { result } = renderHook(() => useWorktreeTabs(tasks, WORKTREES));
  const tab = result.current.find((t) => t.branch === ORPHAN_BRANCH_TASK.branch);
  expect(tab).toBeDefined();
  expect(tab).toMatchObject({ taskCount: 1, dirty: false, aheadOfBase: 0, changedFiles: 0 });
  // Live worktrees are preserved alongside the synthesized branch tab.
  expect(result.current.map((t) => t.branch)).toEqual([
    null,
    'nc/api-client',
    'nc/auth-guard',
    'nc/shiki-trim',
  ]);
});

test('useWorktreeTabs: a live worktree branch does not double up with its task branch', () => {
  // t-running lives on nc/api-client, which is also a live worktree → one tab, not two.
  const tasks = [TASKS_BY_STATUS.in_progress];
  const { result } = renderHook(() => useWorktreeTabs(tasks, WORKTREES));
  const apiTabs = result.current.filter((t) => t.branch === 'nc/api-client');
  expect(apiTabs).toHaveLength(1);
  expect(apiTabs[0]).toMatchObject({ taskCount: 1, dirty: true, aheadOfBase: 2, changedFiles: 3 });
});

test('invariant: every task is reachable via exactly the tabs, none filtered out of all', () => {
  // The board header count must equal the sum of tasks reachable through the tabs.
  const tasks = [
    MAIN_MODE_TASK,
    PENDING_WORKTREE_TASK,
    ORPHAN_BRANCH_TASK,
    ...Object.values(TASKS_BY_STATUS),
  ];
  const { result } = renderHook(() => useWorktreeTabs(tasks, WORKTREES));
  const reachable = new Set<string>();
  for (const tab of result.current)
    for (const task of filterTasksByWorktree(tasks, tab.branch)) reachable.add(task.id);
  expect(reachable.size).toBe(tasks.length);
  // And the tab counts sum to the total (no task counted in zero tabs).
  const summed = result.current.reduce((n, tab) => n + tab.taskCount, 0);
  expect(summed).toBe(tasks.length);
});
