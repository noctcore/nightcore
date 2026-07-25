import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ProjectsView.stories';

const { Populated, Empty } = composeStories(stories);

test('opens a project from its card', async () => {
  const onOpen = vi.fn();
  const screen = render(<Populated onOpen={onOpen} />);
  await screen.getByText('nightcore', { exact: true }).click();
  expect(onOpen).toHaveBeenCalledWith('nightcore');
});

test('derives done/failed counts for the active project', async () => {
  const screen = render(<Populated />);
  // Every card renders the stat labels; the active project's tiles carry the
  // derived counts (one done, one failed).
  await expect.element(screen.getByText('done').first()).toBeInTheDocument();
  await expect.element(screen.getByText('failed').first()).toBeInTheDocument();
});

test('renders a muted dash for non-active projects instead of fake zeroes', async () => {
  const screen = render(<Populated />);
  // The active project (nightcore) shows real counts; the other project has no
  // loaded tasks, so its three stat tiles render "–" rather than 0/0/0.
  await expect.element(screen.getByText('–').first()).toBeInTheDocument();
});

test('shows the empty state and triggers new project', async () => {
  const onNewProject = vi.fn();
  const screen = render(<Empty onNewProject={onNewProject} />);
  await expect.element(screen.getByText('No projects yet')).toBeInTheDocument();
  await screen.getByText('Add your first project').click();
  expect(onNewProject).toHaveBeenCalled();
});
