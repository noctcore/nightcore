import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './BoardHeader.stories';

const { Default, AutoModeOn } = composeStories(stories);

test('renders the title, task-count chip, and project subtitle', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByRole('heading', { name: /kanban board/i }))
    .toBeInTheDocument();
  await expect.element(screen.getByText('7 tasks')).toBeInTheDocument();
  await expect.element(screen.getByText('~/dev/nightcore')).toBeInTheDocument();
  await expect.element(screen.getByText('main')).toBeInTheDocument();
});

test('reflects the live loop state on the Auto Mode toggle', async () => {
  const screen = render(<AutoModeOn />);
  await expect
    .element(screen.getByRole('button', { name: 'Auto Mode', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
});

test('clicking Auto Mode drives the context toggle handler', async () => {
  const onToggleAutoMode = vi.fn();
  const screen = render(<Default onToggleAutoMode={onToggleAutoMode} />);
  await screen.getByRole('button', { name: 'Auto Mode', exact: true }).click();
  expect(onToggleAutoMode).toHaveBeenCalled();
});

test('New task relays through its prop', async () => {
  const onNewTask = vi.fn();
  const screen = render(<Default onNewTask={onNewTask} />);
  await screen.getByRole('button', { name: /new task/i }).click();
  expect(onNewTask).toHaveBeenCalled();
});
