import { expect, test } from 'vitest';
import { renderHook } from 'vitest-browser-react';

import {
  MAIN_MODE_TASK,
  MANY_WORKTREE_TASKS,
  MANY_WORKTREES,
  PENDING_WORKTREE_TASK,
  TASKS_BY_STATUS,
  WORKTREES,
} from '../_fixtures';
import { useWorktreeTabs } from './WorktreeSwitcher.hooks';
import type { WorktreeTab } from './WorktreeSwitcher.types';
import {
  COLLAPSE_THRESHOLD,
  filterTasksByWorktree,
  partitionWorktreeTabs,
  summarizeCollapsed,
  worktreeRemovalMessage,
} from './WorktreeSwitcher.utils';

const REMOVABLE_TAB: WorktreeTab = {
  branch: 'nc/api-client',
  label: 'nc/api-client',
  taskIds: ['t1'],
  taskTitles: ['Generate API client'],
  taskCount: 1,
  runningCount: 0,
  dirty: false,
  aheadOfBase: 0,
  behindOfBase: 0,
  changedFiles: 0,
};

test('worktreeRemovalMessage: a clean worktree names the branch without a data-loss clause', () => {
  const msg = worktreeRemovalMessage(REMOVABLE_TAB);
  expect(msg).toContain('nc/api-client');
  expect(msg).not.toMatch(/uncommitted|lost/i);
});

test('worktreeRemovalMessage: a dirty worktree names the uncommitted-file count that is lost', () => {
  const msg = worktreeRemovalMessage({ ...REMOVABLE_TAB, dirty: true, changedFiles: 3 });
  expect(msg).toContain('nc/api-client');
  expect(msg).toContain('3 uncommitted files');
  expect(msg).toMatch(/lost/i);
});

test('worktreeRemovalMessage: a dirty worktree with no file count still warns about lost changes', () => {
  const msg = worktreeRemovalMessage({ ...REMOVABLE_TAB, dirty: true, changedFiles: 0 });
  expect(msg).toMatch(/uncommitted changes will be lost/i);
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

// --- Overflow / collapse partition -------------------------------------------

test('partitionWorktreeTabs: keeps every tab inline at or below the threshold', () => {
  const { result } = renderHook(() => useWorktreeTabs([MAIN_MODE_TASK], WORKTREES));
  // Main + two live worktrees = 3 tabs (<= COLLAPSE_THRESHOLD).
  expect(result.current.length).toBeLessThanOrEqual(COLLAPSE_THRESHOLD);
  const { inline, collapsed } = partitionWorktreeTabs(result.current);
  expect(inline).toEqual(result.current);
  expect(collapsed).toEqual([]);
});

test('partitionWorktreeTabs: pins Main inline and collapses the worktrees above it', () => {
  const { result } = renderHook(() => useWorktreeTabs(MANY_WORKTREE_TASKS, MANY_WORKTREES));
  expect(result.current.length).toBeGreaterThan(COLLAPSE_THRESHOLD);
  const { inline, collapsed } = partitionWorktreeTabs(result.current);
  // Only Main stays inline; every worktree (active included) collapses.
  expect(inline.map((t) => t.branch)).toEqual([null]);
  expect(collapsed.every((t) => t.branch !== null)).toBe(true);
  expect(inline.length + collapsed.length).toBe(result.current.length);
});

test('summarizeCollapsed: aggregates the count, running, and diverged state', () => {
  const { result } = renderHook(() => useWorktreeTabs(MANY_WORKTREE_TASKS, MANY_WORKTREES));
  const { collapsed } = partitionWorktreeTabs(result.current);
  const summary = summarizeCollapsed(collapsed);
  expect(summary.count).toBe(6);
  expect(summary.anyRunning).toBe(true);
  // Two worktrees run a task (nc/api-client in_progress, nc/search-index verifying).
  expect(summary.runningCount).toBe(2);
  // Two worktrees have diverged (nc/rate-limiter 3/1, nc/search-index 5/4).
  expect(summary.divergedCount).toBe(2);
});
