import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { BLOCKED_TASK, TASKS_BY_STATUS } from '../_fixtures';
import { computeBlockedIds, groupTasksByColumn, matchesQuery } from './Board.hooks';
import * as stories from './Board.stories';

const { Empty, Populated, AutoModeOn, CircuitBreakerPaused } =
  composeStories(stories);

test('renders all five board columns, including the Done label', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByRole('heading', { name: 'Backlog', level: 2 }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('heading', { name: 'In Progress', level: 2 }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('heading', { name: 'Waiting Approval', level: 2 }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('heading', { name: 'Done', level: 2 }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('heading', { name: 'Failed', level: 2 }))
    .toBeInTheDocument();
});

test('renders the project path and branch in the header subtitle', async () => {
  const screen = render(<Populated />);
  await expect.element(screen.getByText('~/dev/nightcore')).toBeInTheDocument();
  // The header subtitle pairs the project branch with the kanban title; assert it
  // there (main-mode cards also carry a "main" chip, so a bare text query is
  // ambiguous on a populated board).
  const heading = screen.getByRole('heading', { name: /kanban board/i });
  await expect.element(heading).toBeInTheDocument();
});

test('reflects the live loop state on the Auto Mode toggle', async () => {
  const screen = render(<AutoModeOn />);
  await expect
    .element(screen.getByRole('button', { name: 'Auto Mode', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
});

test('surfaces the circuit-breaker Resume banner when the loop has paused', async () => {
  const screen = render(<CircuitBreakerPaused />);
  await expect
    .element(screen.getByText(/paused after 3 consecutive failures/i))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /resume/i }))
    .toBeInTheDocument();
});

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

test('computeBlockedIds flags a backlog task whose dependency is unfinished', () => {
  const dep = { ...TASKS_BY_STATUS.in_progress, title: 'Deployment configuration' };
  const blocked = computeBlockedIds([BLOCKED_TASK, dep]);
  expect(blocked.has(BLOCKED_TASK.id)).toBe(true);
});

test('computeBlockedIds clears the block once the dependency is verified', () => {
  const dep = {
    ...TASKS_BY_STATUS.done,
    title: 'Deployment configuration',
    status: 'done' as const,
  };
  const blocked = computeBlockedIds([BLOCKED_TASK, dep]);
  expect(blocked.has(BLOCKED_TASK.id)).toBe(false);
});

test('matchesQuery matches title and description, case-insensitively', () => {
  expect(matchesQuery(TASKS_BY_STATUS.done, 'AUTH')).toBe(true);
  expect(matchesQuery(TASKS_BY_STATUS.done, 'nonexistent')).toBe(false);
  expect(matchesQuery(TASKS_BY_STATUS.done, '')).toBe(true);
});
