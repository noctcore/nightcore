import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './HarnessView.stories';

const { Idle, NoProject } = composeStories(stories);

test('renders the Harness header for an active project', async () => {
  const screen = render(<Idle />);
  await expect.element(screen.getByRole('heading', { name: 'Harness' })).toBeInTheDocument();
  await expect.element(screen.getByText('acme')).toBeInTheDocument();
});

test('opens on the CONFIGURE screen with the run-config hero and Scan CTA', async () => {
  const screen = render(<Idle />);
  // Idle (no persisted run) derives the CONFIGURE phase: the run-config hero.
  await expect.element(screen.getByText(/run config/i)).toBeInTheDocument();
  await expect.element(screen.getByText(/scans the whole repo across/i)).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: /^scan$/i })).toBeInTheDocument();
});

test('shows the empty state when no project is active', async () => {
  const screen = render(<NoProject />);
  await expect.element(screen.getByText('No active project')).toBeInTheDocument();
});
