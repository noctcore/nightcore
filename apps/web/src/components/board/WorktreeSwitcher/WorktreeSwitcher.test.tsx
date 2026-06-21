import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import { filterTasksByWorktree } from './WorktreeSwitcher.hooks';
import * as stories from './WorktreeSwitcher.stories';
import { MAIN_MODE_TASK, TASKS_BY_STATUS } from '../_fixtures';

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
