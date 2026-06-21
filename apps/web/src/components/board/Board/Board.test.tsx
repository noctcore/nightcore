import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test } from 'vitest';
import * as stories from './Board.stories';
import { groupTasksByColumn } from './Board.hooks';
import { TASKS_BY_STATUS } from '../_fixtures';

const { Empty, Populated } = composeStories(stories);

test('renders the four board columns when empty', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText('Backlog')).toBeInTheDocument();
  await expect.element(screen.getByText('In Progress')).toBeInTheDocument();
  await expect.element(screen.getByText('Done')).toBeInTheDocument();
  await expect.element(screen.getByText('Failed')).toBeInTheDocument();
});

test('renders the populated board', async () => {
  const screen = render(<Populated />);
  await expect.element(screen.getByText('In Progress')).toBeInTheDocument();
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
