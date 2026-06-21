import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './TaskDetail.stories';
import { deriveTaskDetailView } from './TaskDetail.hooks';
import { EMPTY_STREAM } from '../session-stream';
import { makeTask } from '../_fixtures';

const { Running, Failed } = composeStories(stories);

test('shows the live transcript heading and cancel control while running', async () => {
  const screen = render(<Running />);
  await expect.element(screen.getByText('Live transcript')).toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /cancel run/i }))
    .toBeInTheDocument();
});

test('renders the persisted error for a failed task', async () => {
  const onRun = vi.fn();
  const screen = render(<Failed onRun={onRun} />);
  await expect
    .element(screen.getByText("cannot resolve 'sass-loader'"))
    .toBeInTheDocument();
});

test('deriveTaskDetailView prefers the live stream over persisted values', () => {
  const task = makeTask({ status: 'in_progress', costUsd: 0.1, summary: 'old' });
  const view = deriveTaskDetailView(task, {
    ...EMPTY_STREAM,
    answer: 'live',
    costUsd: 0.5,
  });
  expect(view.isRunning).toBe(true);
  expect(view.cost).toBe(0.5);
  expect(view.answer).toBe('live');
});
