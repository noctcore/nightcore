import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render, renderHook } from 'vitest-browser-react';

import {
  MAIN_MODE_TASK,
  MANY_WORKTREE_TASKS,
  MANY_WORKTREES,
  ORPHAN_BRANCH_TASK,
  PENDING_WORKTREE_TASK,
  TASKS_BY_STATUS,
  WORKTREES,
} from '../_fixtures';
import {
  COLLAPSE_THRESHOLD,
  filterTasksByWorktree,
  partitionWorktreeTabs,
  summarizeCollapsed,
  useWorktreeTabs,
} from './WorktreeSwitcher.hooks';
import * as stories from './WorktreeSwitcher.stories';

const {
  MainSelected,
  WorktreeSelected,
  FallbackToTaskBranches,
  HiddenWhenOnlyMain,
  ManyWorktreesCollapsed,
  CollapsedWorktreeSelected,
} = composeStories(stories);

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

test('the per-tab actions menu fires onRemoveWorktree with the tab', async () => {
  const onRemoveWorktree = vi.fn();
  const screen = render(<MainSelected onRemoveWorktree={onRemoveWorktree} />);
  await screen
    .getByRole('button', { name: /worktree actions for nc\/api-client/i })
    .click();
  await screen.getByRole('menuitem', { name: /remove worktree/i }).click();
  expect(onRemoveWorktree).toHaveBeenCalledWith(
    expect.objectContaining({ branch: 'nc/api-client' }),
  );
});

test('the Main tab has no actions menu (not removable)', async () => {
  const screen = render(<MainSelected />);
  // The kebab exists for worktree tabs…
  await expect
    .element(screen.getByRole('button', { name: /worktree actions for nc\/api-client/i }))
    .toBeInTheDocument();
  // …but never for Main.
  expect(
    screen.container.querySelector('[aria-label="Worktree actions for Main"]'),
  ).toBeNull();
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

test('useWorktreeTabs: a worktree tab carries its task ids (Main carries none)', () => {
  const tasks = [MAIN_MODE_TASK, TASKS_BY_STATUS.in_progress];
  const { result } = renderHook(() => useWorktreeTabs(tasks, WORKTREES));
  const api = result.current.find((t) => t.branch === 'nc/api-client');
  // The tab exposes the discard targets for its "Remove worktree" action.
  expect(api?.taskIds).toContain('t-running');
  const main = result.current.find((t) => t.branch === null);
  expect(main?.taskIds).toEqual([]);
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

test('useWorktreeTabs: a worktree tab carries its task titles for search', () => {
  const { result } = renderHook(() => useWorktreeTabs(MANY_WORKTREE_TASKS, MANY_WORKTREES));
  const api = result.current.find((t) => t.branch === 'nc/api-client');
  expect(api?.taskTitles).toEqual(['Generate API client']);
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

// --- Overflow / collapse rendering + interaction -----------------------------

test('above the threshold, Main stays a tab while the worktrees collapse into a select', async () => {
  const screen = render(<ManyWorktreesCollapsed />);
  await expect.element(screen.getByRole('tab', { name: /^main/i })).toBeInTheDocument();
  // A collapsed worktree is no longer an inline tab…
  expect(screen.getByRole('tab', { name: /nc\/api-client/i }).query()).toBeNull();
  // …it lives behind the aggregate trigger instead.
  await expect
    .element(screen.getByRole('button', { name: /worktrees/i }))
    .toBeInTheDocument();
});

test('opening the collapsed select lists every collapsed worktree as an option', async () => {
  const screen = render(<ManyWorktreesCollapsed />);
  await screen.getByRole('button', { name: /worktrees/i }).click();
  await expect.element(screen.getByRole('listbox', { name: /worktrees/i })).toBeInTheDocument();
  await expect
    .element(screen.getByRole('option', { name: /nc\/api-client/i }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('option', { name: /nc\/search-index/i }))
    .toBeInTheDocument();
});

test('the collapsed list filters by task title, not just branch name', async () => {
  const screen = render(<ManyWorktreesCollapsed />);
  await screen.getByRole('button', { name: /worktrees/i }).click();
  // "pipeline" appears only in nc/telemetry's task title, not in any branch name.
  await screen.getByRole('combobox', { name: /search worktrees/i }).fill('pipeline');
  await expect
    .element(screen.getByRole('option', { name: /nc\/telemetry/i }))
    .toBeInTheDocument();
  expect(screen.getByRole('option', { name: /nc\/api-client/i }).query()).toBeNull();
});

test('the collapsed list shows an empty state when nothing matches', async () => {
  const screen = render(<ManyWorktreesCollapsed />);
  await screen.getByRole('button', { name: /worktrees/i }).click();
  await screen.getByRole('combobox', { name: /search worktrees/i }).fill('zzz-nope');
  await expect.element(screen.getByText('No matching worktrees')).toBeInTheDocument();
});

test('selecting a collapsed worktree reports its branch', async () => {
  const onSelect = vi.fn();
  const screen = render(<ManyWorktreesCollapsed onSelect={onSelect} />);
  await screen.getByRole('button', { name: /worktrees/i }).click();
  await screen.getByRole('option', { name: /nc\/rate-limiter/i }).click();
  expect(onSelect).toHaveBeenCalledWith('nc/rate-limiter');
});

test('arrow-down + Enter picks a worktree from the collapsed list', async () => {
  const onSelect = vi.fn();
  const screen = render(<ManyWorktreesCollapsed onSelect={onSelect} />);
  await screen.getByRole('button', { name: /worktrees/i }).click();
  // The first row is pre-highlighted, so ArrowDown lands on the second worktree.
  await userEvent.keyboard('{ArrowDown}{Enter}');
  expect(onSelect).toHaveBeenCalledWith('nc/auth-guard');
});

test('Escape closes the collapsed panel', async () => {
  const screen = render(<ManyWorktreesCollapsed />);
  await screen.getByRole('button', { name: /worktrees/i }).click();
  await expect.element(screen.getByRole('listbox', { name: /worktrees/i })).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  expect(screen.container.querySelector('[role="listbox"]')).toBeNull();
});

test('the active collapsed worktree is reflected in the trigger and its row', async () => {
  const screen = render(<CollapsedWorktreeSelected />);
  // The trigger label reflects the active selection instead of the neutral count.
  await expect
    .element(screen.getByRole('button', { name: /nc\/rate-limiter/i }))
    .toBeInTheDocument();
  await screen.getByRole('button', { name: /nc\/rate-limiter/i }).click();
  await expect
    .element(screen.getByRole('option', { name: /nc\/rate-limiter/i, selected: true }))
    .toBeInTheDocument();
});

test('the Main tab stays keyboard-focusable when a collapsed worktree is active', async () => {
  const onSelect = vi.fn();
  const screen = render(<CollapsedWorktreeSelected onSelect={onSelect} />);
  const main = screen.getByRole('tab', { name: /^main/i });
  // Roving-tabindex invariant: with the active worktree folded into the overflow
  // select, Main is the tablist's sole inline tab and must remain the `tabIndex=0`
  // entry point — otherwise a keyboard-only user could Tab to the select trigger but
  // never reach Main to return to the main board (Main is not a dropdown option).
  await expect.element(main).toHaveAttribute('tabindex', '0');
  const el = main.element() as HTMLElement;
  el.focus();
  await expect.element(main).toHaveFocus();
  // …and activating it returns to the main board.
  el.click();
  expect(onSelect).toHaveBeenCalledWith(null);
});

test('inline selection keeps the roving entry on the active worktree, not Main', async () => {
  // Regression guard for the collapsed fix: below the threshold every tab is inline,
  // so the single `tabIndex=0` entry must sit on the SELECTED worktree, with Main at -1.
  const screen = render(<WorktreeSelected />);
  await expect
    .element(screen.getByRole('tab', { name: /nc\/api-client/i }))
    .toHaveAttribute('tabindex', '0');
  await expect.element(screen.getByRole('tab', { name: /^main/i })).toHaveAttribute('tabindex', '-1');
});
