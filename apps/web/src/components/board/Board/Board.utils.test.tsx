import { expect, test } from 'vitest';

import { BLOCKED_TASK, ORPHAN_BRANCH_TASK, TASKS_BY_STATUS, WORKTREES } from '../_fixtures';
import {
  dependencyChipsByTask,
  groupTasksByColumn,
  isGhostWorktree,
  matchesQuery,
  resolveDependencies,
} from './Board.utils';

test('groupTasksByColumn places each task in its status column, newest first', () => {
  const grouped = groupTasksByColumn([
    { ...TASKS_BY_STATUS.backlog, updatedAt: 1 },
    { ...TASKS_BY_STATUS.ready, updatedAt: 2 },
    TASKS_BY_STATUS.done,
  ]);
  const backlog = grouped.find((c) => c.def.key === 'backlog');
  expect(backlog?.tasks.map((t) => t.updatedAt)).toEqual([2, 1]);
  expect(grouped.find((c) => c.def.key === 'done')?.tasks).toHaveLength(1);
});

test('resolveDependencies maps dependency IDs to titles + satisfied state', () => {
  const byId = new Map([[TASKS_BY_STATUS.in_progress.id, TASKS_BY_STATUS.in_progress]]);
  // BLOCKED_TASK depends on the still-running t-running task (by id).
  const chips = resolveDependencies(BLOCKED_TASK, byId);
  expect(chips).toHaveLength(1);
  const chip = chips[0]!;
  expect(chip.id).toBe('t-running');
  expect(chip.title).toBe('Generate API client');
  expect(chip.satisfied).toBe(false);
});

test('resolveDependencies marks a Done dependency satisfied', () => {
  const done = { ...TASKS_BY_STATUS.in_progress, status: 'done' as const };
  const byId = new Map([[done.id, done]]);
  expect(resolveDependencies(BLOCKED_TASK, byId)[0]?.satisfied).toBe(true);
});

test('resolveDependencies reports a deleted dependency with a null title', () => {
  const chip = resolveDependencies(BLOCKED_TASK, new Map())[0];
  expect(chip?.title).toBeNull();
  expect(chip?.satisfied).toBe(false);
});

test('dependencyChipsByTask only maps tasks that declare dependencies', () => {
  const map = dependencyChipsByTask([BLOCKED_TASK, TASKS_BY_STATUS.in_progress]);
  expect(map.has(BLOCKED_TASK.id)).toBe(true);
  // A task with no dependencies gets no entry (stable `undefined` prop for the card).
  expect(map.has(TASKS_BY_STATUS.in_progress.id)).toBe(false);
});

test('matchesQuery matches title and description, case-insensitively', () => {
  expect(matchesQuery(TASKS_BY_STATUS.done, 'AUTH')).toBe(true);
  expect(matchesQuery(TASKS_BY_STATUS.done, 'nonexistent')).toBe(false);
  expect(matchesQuery(TASKS_BY_STATUS.done, '')).toBe(true);
});

// Regression: after a merge removes the worktree AND clears its task's branch, the
// active selection points at a branch that exists on neither a live worktree nor any
// task. Left un-reset, the board stays scoped to that dead branch → empty columns
// until the user switches projects. isGhostWorktree drives the self-heal to Main.
test('isGhostWorktree flags a merged-and-removed branch (no worktree, no task)', () => {
  // The merged task's branch was set to null; no worktree remains on nc/merged.
  const tasks = [{ ...TASKS_BY_STATUS.done, branch: null }];
  expect(isGhostWorktree('nc/merged', tasks, [])).toBe(true);
});

test('isGhostWorktree never flags Main', () => {
  expect(isGhostWorktree(null, [ORPHAN_BRANCH_TASK], WORKTREES)).toBe(false);
});

test('isGhostWorktree keeps a selection backed by a live worktree', () => {
  // nc/api-client has a live worktree in the WORKTREES fixture.
  expect(isGhostWorktree('nc/api-client', [], WORKTREES)).toBe(false);
});

test('isGhostWorktree keeps a task branch whose worktree dir does not exist yet', () => {
  // ORPHAN_BRANCH_TASK (nc/shiki-trim) has a branch but no live worktree — a valid
  // tab, so it must NOT be cleared as a ghost (guards against over-healing).
  expect(isGhostWorktree('nc/shiki-trim', [ORPHAN_BRANCH_TASK], [])).toBe(false);
});
